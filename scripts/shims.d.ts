// Ambient declarations for the CommonJS font tools used only by the offline atlas
// generator. They ship no TypeScript types; the generator runs under tsx (no typecheck),
// so these keep an editor/tsc happy without pulling real type packages into the app build.
declare module 'msdf-bmfont-xml'
declare module 'opentype.js'
