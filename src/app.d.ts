// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      /** Login-gate state for the current request (set by hooks.server.ts handle). */
      auth: {
        /** This request originates from loopback (login-free). */
        isLoopback: boolean;
        /** A usable operator credential exists in the DB (first run is false). */
        hasCredential: boolean;
        /** The request is authenticated (loopback, or a valid signed cookie). */
        authed: boolean;
      };
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
