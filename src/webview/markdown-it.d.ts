// The part of markdown-it the panel uses; the package has no types of its own.
declare module "markdown-it" {
  interface Options {
    html?: boolean;
    linkify?: boolean;
    breaks?: boolean;
    typographer?: boolean;
  }
  export default class MarkdownIt {
    constructor(options?: Options);
    render(source: string): string;
  }
}
