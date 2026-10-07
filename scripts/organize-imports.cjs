const fs = require('node:fs');
const path = require('node:path');
const ts = require('../apps/api/node_modules/typescript');

// Usa el analizador de TypeScript para ordenar imports y quitar los no utilizados.
for (const project of ['apps/api', 'apps/web']) {
  const configPath = path.resolve(project, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const host = {
    ...ts.sys,
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: () => '0',
    getScriptSnapshot: (file) => {
      const text = ts.sys.readFile(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => process.cwd(),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  };
  const service = ts.createLanguageService(host);
  for (const file of parsed.fileNames.filter((file) => !file.endsWith('.d.ts'))) {
    for (const change of service.organizeImports({ type: 'file', fileName: file }, {}, {})) {
      let text = fs.readFileSync(change.fileName, 'utf8');
      for (const edit of [...change.textChanges].sort((a, b) => b.span.start - a.span.start)) {
        text =
          text.slice(0, edit.span.start) +
          edit.newText +
          text.slice(edit.span.start + edit.span.length);
      }
      fs.writeFileSync(change.fileName, text);
    }
  }
  service.dispose();
}
