'use babel';

import { CompositeDisposable, File } from 'atom'
import { VM } from 'vm2'
import YAML from 'yaml'

import { parseFudomo, loadModel, transform, generateSkeletonModule } from 'fudomo-transform' // TODO use ES6 modules

const CONFIG_FILE_EXTENSION = 'config';
const FUDOMO_FILE_EXTENSION = 'fudomo';

function showError(message, detail) {
  atom.notifications.addError(message, { dismissable: true, detail: detail });
}

function hasFileExtension(event, extension) {
  // The click was on an element in li.file, find the li itself
  let listItem = null;
  for (const element of event.path.filter((o) => o instanceof HTMLElement)) {
    if (element.matches('.tree-view .file')) {
      listItem = element;
      break;
    }
  }

  // Check if the li is for a file that has the right kind of name
  // by looking for the span inside it with the matching data-name attribute.
  return listItem != null && listItem.querySelector('.name[data-name$=".' + extension + '"]') != null;
}

function getSelectedFilesWithExtension(treeView, extension) {
  const candidatePaths = treeView.selectedPaths();
  const paths = [];
  for (const path of candidatePaths) {
    if (path.endsWith('.' + extension)) {
      paths.push(path);
    }
  }
  return paths;
}

function getTransformationErrorsAsMarkDown(transformation) {
  let errorsMd = '';
  for (const error of transformation.errors) {
    errorsMd += `~~~~\n${error.excerpt}\n~~~~\n`;
  }
  return errorsMd;
}

export default {
  subscriptions: null,
  treeView: null,

  activate() {
    this.subscriptions = new CompositeDisposable();

    // Add command for running transformation
    this.subscriptions.add(atom.commands.add('atom-workspace', {
      'language-fudomo:runTransformation': () => this.runTransformation(),
      'language-fudomo:generateFunctions': () => this.generateFunctions()
    }))

    this.subscriptions.add(atom.contextMenu.add({
      // Add dynamic context menu entry for running transform.
      // Static context menu definition is not optimal because the CSS selector
      // that would need to be used to restrict the menu entry to appear
      // only on '.config'-files would select only the label, not the list item,
      // leading to confusing usability issues (like the entry only appearing when clicking
      // on the label in the list item, but not when clicking on the list item itself.).
      '.tree-view .file': [
        { 'label': 'Run Fudomo Transformation',
          'command':  'language-fudomo:runTransformation',
          'shouldDisplay': (event) => hasFileExtension(event, CONFIG_FILE_EXTENSION)
        },
        { 'label': 'Generate Function Skeletons',
          'command': 'language-fudomo:generateFunctions',
          'shouldDisplay': (event) => hasFileExtension(event, FUDOMO_FILE_EXTENSION)
        }
      ]
    }));
  },

  deactivate() {
    this.subscriptions.dispose();
  },

  provideLinter() {
    return {
      name: 'Fudomo',
      scope: 'file', // or 'project'
      lintsOnChange: false, // or true
      grammarScopes: ['source.fudomo'],
      lint(textEditor) {
        const editorPath = textEditor.getPath()
        const buffer = textEditor.getBuffer();
        const text = buffer.getText();

        const transformation = parseFudomo(text);
        const errors = transformation.errors;
        // add location for Atom
        for (const error of errors) {
          error.location = {
            position: [buffer.positionForCharacterIndex(error.startOffset), buffer.positionForCharacterIndex(error.endOffset)],
            file: editorPath
          };
        }
        return errors;
      }
    }
  },

  consumeTreeView(treeView) {
    this.treeView = treeView;
  },

  runTransformation() {

    for (const path of getSelectedFilesWithExtension(this.treeView, CONFIG_FILE_EXTENSION)) {
      const file = new File(path);
      const baseDir = file.getParent();
      file.read(true).then(function(configText) {
        let config = null;
        try {
          config = YAML.parse(configText);
        } catch(error) {
          showError('Could not parse Fudomo transformation configuration', 'YAML Parser Error: ' + error.message);
          return;
        }

        const decompPath = config.decomposition;
        const decompPromise = baseDir.getFile(decompPath).read(true);

        const funcPath = config.functions;
        const funcPromise = baseDir.getFile(funcPath).read(true);

        const dataPath = config.data;

        const outputPath = config.output;

        let model = null;
        try {
          model = loadModel(baseDir.getFile(dataPath).getPath());
        } catch(error) {
          showError('Could not load data from "' + dataPath + '"', 'Error: ' + error.message);
          return;
        }

        Promise.all([decompPromise, funcPromise]).then(function(parts) {
          [decompSource, functionSource] = parts;

          const vm = new VM({
              sandbox: { 'module': {} }
          });
          let functionsModule = null;
          try {
            functionsModule = vm.run(functionSource);
          } catch(error) {
            showError('Could not load Fudomo decomposition functions from "' + funcPath + '"', 'Error: ' + error.message);
            return;
          }

          const transformation = parseFudomo(decompSource);
          if (transformation.hasError) {
            const errorsMd = getTransformationErrorsAsMarkDown(transformation);
            atom.notifications.addError('Could not parse Fudomo decomposition definition from "' + decompPath + '"', { dismissable: true, description: errorsMd });
          } else {
            transformation.externalFunctions = functionsModule;
            log = indentLog = dedentLog = function() {};
            try {
              let result = transform(transformation, model, log, indentLog, dedentLog);
              baseDir.getFile(outputPath).write(result).catch(function(error) {
                showError('Could not write Fudomo transformation result to destination file "' + outputPath + '"', 'Error: ' + error.message);
              });
            } catch(error) {
              showError('Could not run Fudomo transformation', 'Error: ' + error.message);
              return;
            }
          }
        }).catch(function(error) {
          showError('Could not read Fudomo decomposition or functions file', 'Error: ' + error.message);
        });
      }).catch(function(error) {
        showError('Could not read Fudomo transformation configuration file', 'Error: ' + error.message);
      });
    }
  },

  generateFunctions() {
    for (const path of getSelectedFilesWithExtension(this.treeView, FUDOMO_FILE_EXTENSION)) {
      const file = new File(path);
      const dir = file.getParent();

      // Calculate destination file name like this: 'abc.fudomo' => 'abc_functions.js', 'abc_functions2.js', 'abc_functions3.js', ...
      const filenameNoExt = file.getBaseName().slice(0, -(FUDOMO_FILE_EXTENSION.length + 1));
      let dedupSuffix = '';
      let destFile = dir.getFile(filenameNoExt + '_functions' + String(dedupSuffix) + '.js');
      while (destFile.existsSync()) {
        if (dedupSuffix == '') {
          dedupSuffix = 2;
        }
        destFile = dir.getFile(filenameNoExt + '_functions' + String(dedupSuffix) + '.js');
        dedupSuffix += 1;
      }

      file.read(true).then(function(decompSource) {
        const transformation = parseFudomo(decompSource);
        if (transformation.hasError) {
          const errorsMd = getTransformationErrorsAsMarkDown(transformation);
          atom.notifications.addError('Could not parse Fudomo decomposition definition from "' + path + '"', { dismissable: true, description: errorsMd });
        } else {
          const skeletonSource = generateSkeletonModule(transformation);
          destFile.write(skeletonSource).catch(function(error) {
            showError('Could not write skeleton functions to destination file "' + destFile.getPath() + '"', 'Error: ' + error.message);
          });
        }

      }).catch(function(error) {
        showError('Could not create skeleton functions for Fudomo transformation', 'Error: ' + error.message);
      });
    }
  }
}
