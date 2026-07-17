package httptransport

import (
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

func (h *Handler) startGoogleLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if h.Config.AuthMode != "google" {
		h.writeError(w, http.StatusNotFound, "not_found", "google sign-in is not configured", nil)
		return
	}
	state, err := h.Auth.NewLoginState(r.Context(), r.URL.Query().Get("returnTo"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.setStateCookie(w, state)
	query := url.Values{
		"client_id":     {h.Config.GoogleClientID},
		"redirect_uri":  {h.Config.GoogleRedirect},
		"response_type": {"code"},
		"scope":         {"openid email profile"},
		"state":         {state},
		"prompt":        {"select_account"},
	}
	http.Redirect(w, r, googleAuthorizationEndpoint+"?"+query.Encode(), http.StatusFound)
}

func (h *Handler) googleCallback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if h.Config.AuthMode != "google" {
		h.writeError(w, http.StatusNotFound, "not_found", "google sign-in is not configured", nil)
		return
	}
	if providerError := strings.TrimSpace(r.URL.Query().Get("error")); providerError != "" {
		h.clearStateCookie(w)
		h.writeError(w, http.StatusUnauthorized, "oauth_denied", "Google sign-in was not completed", nil)
		return
	}
	state := r.URL.Query().Get("state")
	stateCookie, err := r.Cookie(auth.StateCookieName)
	if err != nil || state == "" || subtle.ConstantTimeCompare([]byte(state), []byte(stateCookie.Value)) != 1 {
		h.clearStateCookie(w)
		h.writeError(w, http.StatusUnauthorized, "oauth_state_invalid", "the sign-in request expired or was invalid", nil)
		return
	}
	returnPath, err := h.Auth.ConsumeLoginState(r.Context(), state)
	h.clearStateCookie(w)
	if errors.Is(err, auth.ErrInvalidState) {
		h.writeError(w, http.StatusUnauthorized, "oauth_state_invalid", "the sign-in request expired or was already used", nil)
		return
	}
	if err != nil {
		h.handleError(w, err)
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		h.writeError(w, http.StatusUnauthorized, "oauth_code_missing", "Google did not return an authorization code", nil)
		return
	}
	identity, err := h.exchangeGoogleIdentity(r, code)
	if err != nil {
		h.Logger.Warn("google oauth exchange failed", "error", err)
		h.writeError(w, http.StatusBadGateway, "oauth_exchange_failed", "Google sign-in could not be completed", nil)
		return
	}
	user, err := h.Auth.AuthenticateGoogle(r.Context(), identity)
	if errors.Is(err, auth.ErrEmailNotAllowed) {
		h.writeError(w, http.StatusForbidden, "email_not_allowed", "this Google account is not allowed to use Noted", nil)
		return
	}
	if errors.Is(err, auth.ErrIdentityConflict) {
		h.writeError(w, http.StatusConflict, "identity_conflict", "this email is linked to a different Google account", nil)
		return
	}
	if err != nil {
		h.handleError(w, err)
		return
	}
	token, expiresAt, err := h.Auth.NewSession(r.Context(), user.ID, r.UserAgent(), remoteIP(r.RemoteAddr))
	if err != nil {
		h.handleError(w, err)
		return
	}
	h.setSessionCookie(w, token, expiresAt)
	http.Redirect(w, r, strings.TrimRight(h.Config.FrontendURL, "/")+returnPath, http.StatusFound)
}

func (h *Handler) session(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	response := map[string]any{
		"authenticated": false,
		"authMode":      h.Config.AuthMode,
		"development":   h.Config.AuthMode == "development",
		"capabilities": map[string]bool{
			"recognition": h.Service.Recognizer != nil,
		},
	}
	var user app.User
	var err error
	hadSessionCookie := false
	if h.Config.AuthMode == "development" {
		user, err = h.Service.CurrentUser(r.Context(), h.Config.DevUserEmail)
	} else if cookie, cookieErr := r.Cookie(auth.SessionCookieName); cookieErr == nil {
		hadSessionCookie = true
		user, err = h.Auth.ResolveSession(r.Context(), cookie.Value)
	} else {
		err = auth.ErrNotAuthenticated
	}
	if errors.Is(err, auth.ErrNotAuthenticated) {
		if hadSessionCookie {
			h.clearSessionCookie(w)
		}
		h.writeJSON(w, http.StatusOK, response)
		return
	}
	if err != nil {
		h.handleError(w, err)
		return
	}
	response["authenticated"] = true
	response["user"] = user
	h.writeJSON(w, http.StatusOK, response)
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if cookie, err := r.Cookie(auth.SessionCookieName); err == nil {
		if err := h.Auth.DeleteSession(r.Context(), cookie.Value); err != nil {
			h.handleError(w, err)
			return
		}
	}
	h.clearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) exchangeGoogleIdentity(r *http.Request, code string) (auth.GoogleIdentity, error) {
	form := url.Values{
		"client_id":     {h.Config.GoogleClientID},
		"client_secret": {h.Config.GoogleSecret},
		"code":          {code},
		"grant_type":    {"authorization_code"},
		"redirect_uri":  {h.Config.GoogleRedirect},
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodPost, googleTokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return auth.GoogleIdentity{}, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := &http.Client{Timeout: 15 * time.Second}
	response, err := client.Do(request)
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
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&token); err != nil || token.AccessToken == "" {
		return auth.GoogleIdentity{}, errors.New("google token response was invalid")
	}

	request, err = http.NewRequestWithContext(r.Context(), http.MethodGet, googleUserInfoEndpoint, nil)
	if err != nil {
		return auth.GoogleIdentity{}, err
	}
	request.Header.Set("Authorization", "Bearer "+token.AccessToken)
	response, err = client.Do(request)
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
	return auth.GoogleIdentity{Subject: identity.Subject, Email: identity.Email, Verified: identity.EmailVerified, DisplayName: identity.Name, AvatarURL: identity.Picture}, nil
}

func (h *Handler) setStateCookie(w http.ResponseWriter, value string) {
	http.SetCookie(w, &http.Cookie{Name: auth.StateCookieName, Value: value, Path: "/api/auth/google/callback", HttpOnly: true, Secure: h.Config.AppEnv == "production", SameSite: http.SameSiteLaxMode, MaxAge: 600})
}

func (h *Handler) clearStateCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: auth.StateCookieName, Path: "/api/auth/google/callback", HttpOnly: true, Secure: h.Config.AppEnv == "production", SameSite: http.SameSiteLaxMode, MaxAge: -1, Expires: time.Unix(1, 0)})
}

func (h *Handler) setSessionCookie(w http.ResponseWriter, value string, expiresAt time.Time) {
	http.SetCookie(w, &http.Cookie{Name: auth.SessionCookieName, Value: value, Path: "/", HttpOnly: true, Secure: h.Config.AppEnv == "production", SameSite: http.SameSiteLaxMode, Expires: expiresAt, MaxAge: int(time.Until(expiresAt).Seconds())})
}

func (h *Handler) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: auth.SessionCookieName, Path: "/", HttpOnly: true, Secure: h.Config.AppEnv == "production", SameSite: http.SameSiteLaxMode, MaxAge: -1, Expires: time.Unix(1, 0)})
}

func remoteIP(remoteAddress string) string {
	if host, _, err := net.SplitHostPort(remoteAddress); err == nil {
		return host
	}
	return remoteAddress
}
