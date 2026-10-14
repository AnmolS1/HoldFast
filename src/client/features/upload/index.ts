// The uploader. Other features reach it only through the two slot exports, the ribbon store and
// the address (`/uploads?parent=<folderId>`).
export { routes } from "./routes";
export { requestUpload, UploadDropOverlay } from "./slots";
