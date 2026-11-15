/// <reference lib="webworker" />
// Heavy score processing runs here; terminate the worker to cancel at any point.
//
// This is a classic worker (see ProcessingWorkerClient in prepare-processing.ts):
// pdf-lib and OpenCV are the UMD and Emscripten builds the app copies to /intake,
// loaded with importScripts, which module workers do not support. Only their types
// are imported by the modules this one calls, so the Angular build bundles no library
// code into the worker. The work itself lives in processing-build.ts,
// processing-photo.ts and staff-detection.ts; this file only handles messages.
import type { ImportAsset, PageEdit } from '../../core/models';
import { Manifest, PreparedPage, build, matchPages } from './processing-build';
import { analyze, openCV } from './processing-opencv';
import { previewRaster } from './processing-photo';

declare const self: DedicatedWorkerGlobalScope;

type ProcessingRequest = { requestId?: string } & (
  | {
      kind: 'match';
      draftId: string;
      sources: ImportAsset[];
      reference: PageEdit;
      targets: PageEdit[];
    }
  | { kind: 'analyze'; image: ImageData }
  | { kind: 'preview'; raster: Blob; edit: PageEdit; maxEdge?: number }
  | {
      kind?: 'build';
      draftId: string;
      sources: ImportAsset[];
      manifest: Manifest;
      prepared?: PreparedPage[];
      preparedKeys?: string[];
    }
);

self.importScripts('/intake/pdf-lib.min.js');

self.onmessage = async ({ data }: MessageEvent<ProcessingRequest>) => {
  const requestId = data.requestId;
  try {
    if (data.kind === 'match') {
      self.postMessage({
        requestId,
        result: await matchPages(data.draftId, data.sources, data.reference, data.targets),
      });
      return;
    }
    if (data.kind === 'analyze') {
      await openCV();
      self.postMessage({ requestId, result: analyze(data.image) });
      return;
    }
    if (data.kind === 'preview') {
      const result = await previewRaster(data.raster, data.edit, data.maxEdge);
      self.postMessage({ requestId, ...result });
      return;
    }
    const bytes = await build(
      data.draftId,
      data.sources,
      data.manifest,
      data.prepared,
      data.preparedKeys,
      (progress) => self.postMessage({ requestId, progress }),
    );
    self.postMessage({ requestId, bytes }, [bytes]);
  } catch (error) {
    self.postMessage({ requestId, error: error instanceof Error ? error.message : String(error) });
  }
};
