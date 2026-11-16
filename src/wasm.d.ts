// minimal subset used by deepseek/pow.ts, so the project does not have to pull in `lib: DOM`
declare namespace WebAssembly {
  interface Memory {
    readonly buffer: ArrayBuffer;
  }
  interface Module { }
  interface Instance {
    readonly exports: Record<string, unknown>;
  }
  type Imports = Record<string, Record<string, unknown>>;

  function compile(bytes: BufferSource): Promise<Module>;
  function instantiate(module: Module, imports?: Imports): Promise<Instance>;
}
