package httpapi

import (
	"net/http"
	"strconv"

	"github.com/bitofbytes-io/noted/internal/app"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func (h *Handler) listPieces(writer http.ResponseWriter, request *http.Request) {
	options := app.ListOptions{Query: request.URL.Query().Get("q")}
	if value := request.URL.Query().Get("favorite"); value != "" {
		parsed, err := strconv.ParseBool(value)
		if err != nil {
			writeError(writer, http.StatusBadRequest, "favorite must be true or false")
			return
		}
		options.Favorite = &parsed
	}
	var err error
	options.Statuses, err = app.ParseStatusFilter(request.URL.Query().Get("status"), options.Query)
	if err != nil {
		handleError(writer, err)
		return
	}
	options.Sort, err = app.ParseSort(request.URL.Query().Get("sort"))
	if err != nil {
		handleError(writer, err)
		return
	}
	// The library loads summaries once and filters them itself; fields=summary
	// leaves out the notes and adds each piece's folded search text.
	switch request.URL.Query().Get("fields") {
	case "":
	case "summary":
		summaries, err := h.backend.ListPieceSummaries(request.Context(), currentUser(request).ID, options)
		if err != nil {
			handleError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, summaries)
		return
	default:
		writeError(writer, http.StatusBadRequest, "fields must be summary")
		return
	}
	pieces, err := h.backend.ListPieces(request.Context(), currentUser(request).ID, options)
	if err != nil {
		handleError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, pieces)
}

// continuePiece answers {"piece": null} when nothing was played recently.
func (h *Handler) continuePiece(writer http.ResponseWriter, request *http.Request) {
	piece, err := h.backend.ContinuePiece(request.Context(), currentUser(request).ID)
	if err != nil {
		handleError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]*app.Piece{"piece": piece})
}

func (h *Handler) getPiece(writer http.ResponseWriter, request *http.Request) {
	id, ok := pieceID(writer, request)
	if !ok {
		return
	}
	piece, err := h.backend.GetPiece(request.Context(), currentUser(request).ID, id)
	if err != nil {
		handleError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, piece)
}

func (h *Handler) createPiece(writer http.ResponseWriter, request *http.Request) {
	var input app.PieceInput
	if err := decodeJSON(request, &input); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	piece, err := h.backend.CreatePiece(request.Context(), currentUser(request).ID, input)
	if err != nil {
		handleError(writer, err)
		return
	}
	writer.Header().Set("Location", "/api/pieces/"+piece.ID)
	writeJSON(writer, http.StatusCreated, piece)
}

func (h *Handler) updatePiece(writer http.ResponseWriter, request *http.Request) {
	id, ok := pieceID(writer, request)
	if !ok {
		return
	}
	var patch app.PiecePatch
	if err := decodeJSON(request, &patch); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	piece, err := h.backend.UpdatePiece(request.Context(), currentUser(request).ID, id, patch)
	if err != nil {
		handleError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, piece)
}

func (h *Handler) deletePiece(writer http.ResponseWriter, request *http.Request) {
	id, ok := pieceID(writer, request)
	if !ok {
		return
	}
	if err := h.backend.DeletePiece(request.Context(), currentUser(request).ID, id); err != nil {
		handleError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

func pieceID(writer http.ResponseWriter, request *http.Request) (string, bool) {
	id := chi.URLParam(request, "pieceID")
	if _, err := uuid.Parse(id); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid piece id")
		return "", false
	}
	return id, true
}
