package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/bitofbytes-io/noted/internal/auth"
)

const (
	googleAuthorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth"
	googleTokenEndpoint         = "https://oauth2.googleapis.com/token"
	googleUserInfoEndpoint      = "https://openidconnect.googleapis.com/v1/userinfo"
)

type Authenticator interface {
	EnsureDevelopmentUser(context.Context, string) (app.User, error)
	NewLoginState(context.Context, string) (string, error)
	ConsumeLoginState(context.Context, string) (string, error)
	AuthenticateGoogle(context.Context, auth.GoogleIdentity) (app.User, error)
	NewSession(context.Context, string, string, string) (string, time.Time, error)
	ResolveSession(context.Context, string) (app.User, error)
	DeleteSession(context.Context, string) error
}

type userContextKey struct{}

func (h *Handler) startGoogleLogin(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Referrer-Policy", "no-referrer")
	if h.config.AuthMode != "google" {
		writeError(writer, http.StatusNotFound, "google sign-in is not configured")
		return
	}
	state, err := h.auth.NewLoginState(request.Context(), request.URL.Query().Get("returnTo"))
	if err != nil {
		handleError(writer, err)
		return
	}
	h.setStateCookie(writer, state)
	query := url.Values{
		"client_id":     {h.config.GoogleClientID},
		"redirect_uri":  {h.config.GoogleRedirect},
		"response_type": {"code"},
		"scope":         {"openid email profile"},
		"state":         {state},
		"prompt":        {"select_account"},
	}
	http.Redirect(writer, request, googleAuthorizationEndpoint+"?"+query.Encode(), http.StatusFound)
}

func (h *Handler) googleCallback(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Referrer-Policy", "no-referrer")
	if h.config.AuthMode != "google" {
		writeError(writer, http.StatusNotFound, "google sign-in is not configured")
		return
	}
	if strings.TrimSpace(request.URL.Query().Get("error")) != "" {
		h.clearStateCookie(writer)
		writeError(writer, http.StatusUnauthorized, "Google sign-in was not completed")
		return
	}
	state := request.URL.Query().Get("state")
	stateCookie, err := request.Cookie(auth.StateCookieName)
	if err != nil || state == "" ||
		subtle.ConstantTimeCompare([]byte(state), []byte(stateCookie.Value)) != 1 {
		h.clearStateCookie(writer)
		writeError(writer, http.StatusUnauthorized, "the sign-in request expired or was invalid")
		return
	}
	returnPath, err := h.auth.ConsumeLoginState(request.Context(), state)
	h.clearStateCookie(writer)
	if errors.Is(err, auth.ErrInvalidState) {
		writeError(writer, http.StatusUnauthorized, "the sign-in request expired or was already used")
		return
	}
	if err != nil {
		handleError(writer, err)
		return
	}
	code := strings.TrimSpace(request.URL.Query().Get("code"))
	if code == "" {
		writeError(writer, http.StatusUnauthorized, "Google did not return an authorization code")
		return
	}
	identity, err := h.exchangeGoogleIdentity(request, code)
	if err != nil {
		writeError(writer, http.StatusBadGateway, "Google sign-in could not be completed")
		return
	}
	user, err := h.auth.AuthenticateGoogle(request.Context(), identity)
	switch {
	case errors.Is(err, auth.ErrEmailNotAllowed):
		writeError(writer, http.StatusForbidden, "this Google account is not allowed to use Noted")
		return
	case errors.Is(err, auth.ErrIdentityConflict):
		writeError(writer, http.StatusConflict, "this email is linked to a different Google account")
		return
	case err != nil:
		handleError(writer, err)
		return
	}
	token, expiresAt, err := h.auth.NewSession(
		request.Context(), user.ID, request.UserAgent(), remoteIP(request.RemoteAddr),
	)
	if err != nil {
		handleError(writer, err)
		return
	}
	h.setSessionCookie(writer, token, expiresAt)
	http.Redirect(
		writer, request,
		strings.TrimRight(h.config.FrontendURL, "/")+returnPath,
		http.StatusFound,
	)
}

func (h *Handler) session(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	response := map[string]any{
		"authenticated": false,
		"authMode":      h.config.AuthMode,
		"development":   h.config.AuthMode == "development",
	}
	user, err := h.resolveUser(request)
	if errors.Is(err, auth.ErrNotAuthenticated) {
		h.clearSessionCookie(writer)
		writeJSON(writer, http.StatusOK, response)
		return
	}
	if err != nil {
		handleError(writer, err)
		return
	}
	response["authenticated"] = true
	response["user"] = user
	writeJSON(writer, http.StatusOK, response)
}

func (h *Handler) logout(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if cookie, err := request.Cookie(auth.SessionCookieName); err == nil {
		if err := h.auth.DeleteSession(request.Context(), cookie.Value); err != nil {
			handleError(writer, err)
			return
		}
	}
	h.clearSessionCookie(writer)
	writer.WriteHeader(http.StatusNoContent)
}

func (h *Handler) authenticatedUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		user, err := h.resolveUser(request)
		if errors.Is(err, auth.ErrNotAuthenticated) {
			if h.config.AuthMode == "google" {
				h.clearSessionCookie(writer)
			}
			writeError(writer, http.StatusUnauthorized, "sign in to continue")
			return
		}
		if err != nil {
			handleError(writer, err)
			return
		}
		next.ServeHTTP(
			writer,
			request.WithContext(context.WithValue(request.Context(), userContextKey{}, user)),
		)
	})
}

func (h *Handler) resolveUser(request *http.Request) (app.User, error) {
	if h.config.AuthMode == "development" {
		return h.auth.EnsureDevelopmentUser(request.Context(), h.config.DevUserEmail)
	}
	cookie, err := request.Cookie(auth.SessionCookieName)
	if err != nil {
		return app.User{}, auth.ErrNotAuthenticated
	}
	return h.auth.ResolveSession(request.Context(), cookie.Value)
}

func currentUser(request *http.Request) app.User {
	return request.Context().Value(userContextKey{}).(app.User)
}

func (h *Handler) exchangeGoogleIdentity(
	request *http.Request,
	code string,
) (auth.GoogleIdentity, error) {
	form := url.Values{
		"client_id":     {h.config.GoogleClientID},
		"client_secret": {h.config.GoogleSecret},
		"code":          {code},
		"grant_type":    {"authorization_code"},
		"redirect_uri":  {h.config.GoogleRedirect},
	}
	tokenRequest, err := http.NewRequestWithContext(
		request.Context(), http.MethodPost, googleTokenEndpoint, strings.NewReader(form.Encode()),
	)
	if err != nil {
		return auth.GoogleIdentity{}, err
	}
	tokenRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := &http.Client{Timeout: 15 * time.Second}
	response, err := client.Do(tokenRequest)
	if err != nil {
		return auth.GoogleIdentity{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return auth.GoogleIdentity{}, fmt.Errorf("google token endpoint returned %s", response.Status)
	}
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&token); err != nil ||
		token.AccessToken == "" {
		return auth.GoogleIdentity{}, errors.New("google token response was invalid")
	}

	userRequest, err := http.NewRequestWithContext(
		request.Context(), http.MethodGet, googleUserInfoEndpoint, nil,
	)
	if err != nil {
		return auth.GoogleIdentity{}, err
	}
	userRequest.Header.Set("Authorization", "Bearer "+token.AccessToken)
	response, err = client.Do(userRequest)
	if err != nil {
		return auth.GoogleIdentity{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return auth.GoogleIdentity{}, fmt.Errorf("google userinfo endpoint returned %s", response.Status)
	}
	var identity struct {
		Subject       string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
		Picture       string `json:"picture"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&identity); err != nil {
		return auth.GoogleIdentity{}, err
	}
	return auth.GoogleIdentity{
		Subject: identity.Subject, Email: identity.Email, Verified: identity.EmailVerified,
		DisplayName: identity.Name, AvatarURL: identity.Picture,
	}, nil
}

func (h *Handler) setStateCookie(writer http.ResponseWriter, value string) {
	http.SetCookie(writer, &http.Cookie{
		Name: auth.StateCookieName, Value: value, Path: "/api/auth/google/callback",
		HttpOnly: true, Secure: h.config.AppEnv == "production", SameSite: http.SameSiteLaxMode,
		MaxAge: 600,
	})
}

func (h *Handler) clearStateCookie(writer http.ResponseWriter) {
	http.SetCookie(writer, &http.Cookie{
		Name: auth.StateCookieName, Path: "/api/auth/google/callback", HttpOnly: true,
		Secure: h.config.AppEnv == "production", SameSite: http.SameSiteLaxMode,
		MaxAge: -1, Expires: time.Unix(1, 0),
	})
}

func (h *Handler) setSessionCookie(writer http.ResponseWriter, value string, expiresAt time.Time) {
	http.SetCookie(writer, &http.Cookie{
		Name: auth.SessionCookieName, Value: value, Path: "/", HttpOnly: true,
		Secure: h.config.AppEnv == "production", SameSite: http.SameSiteLaxMode,
		Expires: expiresAt, MaxAge: int(time.Until(expiresAt).Seconds()),
	})
}

func (h *Handler) clearSessionCookie(writer http.ResponseWriter) {
	http.SetCookie(writer, &http.Cookie{
		Name: auth.SessionCookieName, Path: "/", HttpOnly: true,
		Secure: h.config.AppEnv == "production", SameSite: http.SameSiteLaxMode,
		MaxAge: -1, Expires: time.Unix(1, 0),
	})
}

func remoteIP(remoteAddress string) string {
	if host, _, err := net.SplitHostPort(remoteAddress); err == nil {
		return host
	}
	return remoteAddress
}
