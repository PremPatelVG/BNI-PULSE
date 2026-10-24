// Module-resolution hook: any import of src/firebaseAdmin.js gets the in-memory fake.
let fakeUrl;
export function initialize(data) { fakeUrl = data.fakeUrl; }
export async function resolve(specifier, context, next) {
  if (/(^|\/)firebaseAdmin\.js$/.test(specifier)) return { url: fakeUrl, shortCircuit: true };
  return next(specifier, context);
}
