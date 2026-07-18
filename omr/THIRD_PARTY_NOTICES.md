# Noted OMR worker: third-party notices and model inventory

This file records the direct OMR components and opaque model artifacts in the
production worker image. It is an engineering inventory, not legal advice.
Package-owned license files remain installed with the Audiveris distribution,
Python `*.dist-info` directories, Debian packages, the Node runtime, and the
alphaTab npm package. The exact Python package set is locked in
`omr/constraints.txt`.

## Recognizers and post-processing

| Component | Exact source | Recorded terms | Shipped modification / use |
|---|---|---|---|
| Audiveris 5.10.2 | <https://github.com/Audiveris/audiveris/tree/5.10.2> and the official `Audiveris-5.10.2-ubuntu22.04-x86_64.deb` release asset | AGPL-3.0-or-later; the package includes `/opt/audiveris/share/doc/copyright` and dependency notices | The official binary is not rebuilt. `Audiveris.cfg` changes only the maximum Java heap from 8 GiB to 2560 MiB. The Dockerfile and this repository are the modification/install instructions. |
| homr 0.7.0 | <https://github.com/liebharc/homr/tree/v0.7.0> | AGPL-3.0-only in the tagged source and Python package | Unmodified package, CPU inference only. Applicable corresponding source is the tagged repository. |
| music21 10.3.0 | <https://github.com/cuthbertLab/music21/tree/v10.3.0> | BSD-3-Clause for code; upstream states that bundled corpus items have separate terms | Parsing, OMR correction, notation, and MusicXML export only. The unused encoded compositions and metadata bundles under `music21/corpus` are deleted in the same image layer in which the package is installed; only the importable Python API modules and upstream corpus notice remain. |
| alphaTab 1.8.4 | <https://github.com/CoderLine/alphaTab/tree/v1.8.4> | MPL-2.0 | Unmodified core npm package, used only for DOM-free import/playability validation. Unused packaged fonts and Sonic Network SoundFonts are deleted in the npm install layer. |
| RapidOCR 3.9.1 | <https://github.com/RapidAI/RapidOCR/tree/v3.9.1> | Apache-2.0 in package metadata and source | Unmodified indirect homr dependency. Its three default ONNX weights are bundled for offline operation and inventoried below. |

The worker is reachable only by the authenticated Noted API over the private
tailnet. Deployments must make the applicable AGPL corresponding source and
modification information available to users who interact with the covered
programs over a network. Process/container separation is not relied upon as an
exception to that obligation.

## ONNX artifacts

Every file below is downloaded during the image build and covered by the
reviewed, checked-in `omr/homr-models.sha256` manifest. The build fails if the
downloaded ONNX filename set or any checksum differs. The same manifest is
installed at `/opt/noted-omr/homr-models.sha256` for offline readiness.

| Artifact | Build source | SHA-256 | Publisher terms / provenance record |
|---|---|---|---|
| `segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.onnx` | <https://github.com/liebharc/homr/releases/download/onnx_checkpoints/segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.onnx> | `6ed36640db4ef5d223098b6d5efe4eda97c66b24a2c72faab8a018c749003a8d` | Published as a homr release asset without a separate model card or license file; treated for release purposes as AGPL-3.0-only under the repository release. homr documents this segmentation model as adapted from MIT-licensed oemer and its CVC-MUSCIMA/DeepScoresV2 training path. CVC-MUSCIMA has research-oriented upstream terms; DeepScoresV2 is CC-BY-4.0. |
| `encoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx` | <https://github.com/liebharc/homr/releases/download/onnx_checkpoints/encoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx> | `4c16df852b3789f2676b0d49f0545dab0740e4005f7b472c5252add642f5d5eb` | Published as a homr release asset without a separate model card or license file; treated for release purposes as AGPL-3.0-only under the repository release. The v0.7.0 training code mixes OpenScore Lieder, OpenScore String Quartets, Camera-PrIMuS, and GrandStaff. It builds on Apache-2.0 Polyphonic-TrOMR. Upstream does not map this exact checkpoint to immutable dataset revisions. |
| `decoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx` | <https://github.com/liebharc/homr/releases/download/onnx_checkpoints/decoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx> | `3e10fd5ae52d0b86792721922fcd954c283a7ed365de7446425bdabe38f3e57d` | Same publisher, terms, training-code provenance, and residual model-card limitation as the encoder. Cite homr, oemer, and Polyphonic-TrOMR when publishing research results. |
| `PP-OCRv6_det_small.onnx` | <https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.1/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx> | `090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f` | RapidAI ModelScope repository records Apache-2.0; derived from PaddleOCR PP-OCRv6. |
| `PP-OCRv6_rec_small.onnx` | <https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.1/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx> | `6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884` | RapidAI ModelScope repository records Apache-2.0; derived from PaddleOCR PP-OCRv6. |
| `ch_ppocr_mobile_v2.0_cls_mobile.onnx` | <https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.1/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx> | `e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c` | RapidAI ModelScope repository records Apache-2.0; derived from PaddleOCR. |

## Model-training provenance limitations

The three homr release assets do not have a standalone model card, immutable
training-data manifest, or a license file attached to each weight. The table
above records the strongest provenance available from the exact v0.7.0 source
and publisher release. It must not be represented as proof that every training
sample was suitable for every jurisdiction or use. Production acceptance is an
explicit owner risk decision for this private, non-public image; any public or
commercial redistribution requires a fresh review or replacement weights with
a complete model card.
