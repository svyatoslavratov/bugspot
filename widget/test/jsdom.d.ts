// The part of jsdom the tests use: a page of its own, with its scripts run.
declare module 'jsdom' {
  export class JSDOM {
    constructor(
      html?: string,
      options?: {
        url?: string;
        runScripts?: 'dangerously' | 'outside-only';
        pretendToBeVisual?: boolean;
        beforeParse?(window: Window & typeof globalThis): void;
      },
    );
    readonly window: Window & typeof globalThis;
  }
}
