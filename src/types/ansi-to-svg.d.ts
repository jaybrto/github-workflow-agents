declare module "ansi-to-svg" {
  interface AnsiToSvgOptions {
    paddingTop?: number;
    paddingLeft?: number;
    paddingBottom?: number;
    paddingRight?: number;
    colors?: string;
    fontFamily?: string;
    fontSize?: number;
  }

  function ansiToSVG(input: string, options?: AnsiToSvgOptions): string;
  export default ansiToSVG;
}
