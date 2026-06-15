/** Allow importing .svg files as raw strings via esbuild text loader */
declare module "*.svg" {
  const content: string;
  export default content;
}
