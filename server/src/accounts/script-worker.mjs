import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
// No host objects/functions enter the context. Only local cc-switch scripts,
// JSON input and JSON output; never accept scripts from the mobile API.
try {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  const source = workerData.extract
    ? `JSON.stringify((${workerData.code}).extractor(JSON.parse(${JSON.stringify(workerData.response)})))`
    : `JSON.stringify((${workerData.code}).request)`;
  const result = new vm.Script(source).runInContext(context, { timeout: 300 });
  if (typeof result !== 'string' || result.length > 2 * 1024 * 1024) throw new Error();
  parentPort.postMessage({ ok: true, value: JSON.parse(result) });
} catch { parentPort.postMessage({ ok: false }); }
