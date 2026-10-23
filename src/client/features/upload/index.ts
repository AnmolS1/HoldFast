// The uploader. Other features reach it only through the two slot exports, the ribbon store, the
// address (`/uploads?parent=<folderId>`) and `scanVerdictsSeen` (the explorer's listing tells the
// ribbon what it learned about a scan).
export { scanVerdictsSeen } from "./manager";
export { routes } from "./routes";
export { requestUpload, UploadDropOverlay } from "./slots";
