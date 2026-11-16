package httpapi

import (
	"net/http"

	"github.com/bitofbytes-io/noted/internal/app"
)

func (h *Handler) getReaderState(writer http.ResponseWriter, request *http.Request) {
	id, ok := pieceID(writer, request)
	if !ok {
		return
	}
	state, err := h.backend.GetReaderState(request.Context(), currentUser(request).ID, id)
	if err != nil {
		handleError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, state)
}

func (h *Handler) putReaderState(writer http.ResponseWriter, request *http.Request) {
	id, ok := pieceID(writer, request)
	if !ok {
		return
	}
	var state app.ReaderState
	if err := decodeJSON(request, &state); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	state, err := h.backend.PutReaderState(request.Context(), currentUser(request).ID, id, state)
	if err != nil {
		handleError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, state)
}
