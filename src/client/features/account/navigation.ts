// Leaving the app for another site (Google's consent screen). An object, so that a test can watch
// the call: `window.location.assign` cannot be replaced in a browser or in jsdom.
export const browserNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};
