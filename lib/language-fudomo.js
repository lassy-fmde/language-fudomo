'use babel';

import { CompositeDisposable, File } from 'atom'
import { VM } from 'vm2'
import YAML from 'yaml'

import { parseFudomo, loadModel, transform, generateSkeletonModule } from 'fudomo-transform' // TODO use ES6 modules
import child_process from 'child_process'
import treeKill from 'tree-kill'

const CONFIG_FILE_EXTENSION = 'config';
const FUDOMO_FILE_EXTENSION = 'fudomo';

function showSuccess(message, buttonText, onButtonClick) {
  const options = {};
  if (buttonText && onButtonClick) {
    options.buttons = [{
      text: buttonText,
      onDidClick: onButtonClick
    }];
  }
  atom.notifications.addSuccess(message, options);
}

function showError(message, detail, buttonText, onButtonClick) {
  const options = { dismissable: true, detail: detail };
  if (buttonText && onButtonClick) {
    options.buttons = [{
      text: buttonText,
      onDidClick: onButtonClick
    }];
  }
  atom.notifications.addError(message, options);
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

const runningPostprocessors = {}; // key is absolute path of data file, value is pid
const killedPostprocessors = {}; // key is pid, value is dummy

export default {
  subscriptions: null,
  treeView: null,
  busySignalApi: null,

  activate() {
    this.subscriptions = new CompositeDisposable();

    // Add command for running transformation
    this.subscriptions.add(atom.commands.add('atom-workspace', {
      'language-fudomo:runTransformation': () => this.runTransformation(),
      'language-fudomo:generateFunctions': () => this.generateFunctions(),
      'language-fudomo:enableAutoTransform': () => this.enableAutoTransform(),
      'language-fudomo:disableAutoTransform': () => this.disableAutoTransform()
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
          'shouldDisplay': event => hasFileExtension(event, CONFIG_FILE_EXTENSION)
        },
        { 'label': 'Enable AutoTransform',
          'command': 'language-fudomo:enableAutoTransform',
          'shouldDisplay': event => this.allowEnableAutoTransform(event)
        },
        { 'label': 'Disable AutoTransform',
          'command': 'language-fudomo:disableAutoTransform',
          'shouldDisplay': event => this.allowDisableAutoTransform(event)
        },
        { 'label': 'Generate Function Skeletons',
          'command': 'language-fudomo:generateFunctions',
          'shouldDisplay': event => hasFileExtension(event, FUDOMO_FILE_EXTENSION)
        }
      ]
    }));

    const thiz = this;
    this.subscriptions.add(atom.project.onDidChangeFiles(events => {
      const autoTransformPaths = atom.config.get('language-fudomo.autoTransformPaths') || {};
      if (Object.keys(autoTransformPaths).length == 0) {
        return;
      }

      const configPaths = [];
      const configReadPromises = [];
      for (const configPath of Object.keys(autoTransformPaths)) {
        if (atom.project.relativizePath(configPath) == null) {
          continue; // Not in currently open project
        }

        configPaths.push(configPath);
        configReadPromises.push(new File(configPath).read(true));
      }

      Promise.all(configReadPromises).then(configTexts => {
        const resolveDataFilePathsPromises = [];
        for (var i = 0; i < configTexts.length; i++) {
          const configText = configTexts[i];
          const configPath = configPaths[i];

          const config = YAML.parse(configText);

          const dataFile = new File(configPath).getParent().getFile(config.data);
          resolveDataFilePathsPromises.push(dataFile.getRealPath());
        }
        return Promise.all(resolveDataFilePathsPromises);
      }).then(dataFileAbsPaths => {
        const configPathsToTransform = new Set();

        for (var i = 0; i < configPaths.length; i++) {
          const configPath = configPaths[i];
          const dataFilePath = dataFileAbsPaths[i];

          for (const event of events) {
            const action = event.action;
            if (action == 'created' || action == 'modified' || action == 'renamed') {
              if (event.path == dataFilePath) {
                configPathsToTransform.add(configPath);
              }
            }
          }
        }

        for (const path of configPathsToTransform) {
          thiz.runTransformationConfigFile(path, notifyOnSuccess = false);
        }
      });
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

  consumeBusySignal(api) {
    this.busySignalApi = api;
  },

  allowEnableAutoTransform(event) {
    const autoTransformPaths = atom.config.get('language-fudomo.autoTransformPaths') || {};
    for (const path of getSelectedFilesWithExtension(this.treeView, CONFIG_FILE_EXTENSION)) {
      if (!(path in autoTransformPaths)) {
        return true;
      }
    }
    return false;
  },

  enableAutoTransform() {
    const autoTransformPaths = atom.config.get('language-fudomo.autoTransformPaths') || {};
    for (const path of getSelectedFilesWithExtension(this.treeView, CONFIG_FILE_EXTENSION)) {
      autoTransformPaths[path] = true;
    }
    atom.config.set('language-fudomo.autoTransformPaths', autoTransformPaths);
  },

  allowDisableAutoTransform(event) {
    const autoTransformPaths = atom.config.get('language-fudomo.autoTransformPaths') || {};
    for (const path of getSelectedFilesWithExtension(this.treeView, CONFIG_FILE_EXTENSION)) {
      if (path in autoTransformPaths) {
        return true;
      }
    }
    return false;
  },

  disableAutoTransform() {
    const autoTransformPaths = atom.config.get('language-fudomo.autoTransformPaths') || {};
    for (const path of getSelectedFilesWithExtension(this.treeView, CONFIG_FILE_EXTENSION)) {
      delete autoTransformPaths[path];
    }
    atom.config.set('language-fudomo.autoTransformPaths', autoTransformPaths);
  },

  runTransformation() {
    for (const path of getSelectedFilesWithExtension(this.treeView, CONFIG_FILE_EXTENSION)) {
      this.runTransformationConfigFile(path);
    }
  },

  runTransformationConfigFile(path, notifyOnSuccess = true) {
    const thiz = this;
    const configFile = new File(path);
    const baseDir = configFile.getParent();
    configFile.read(true).then(function(configText) {
      let config = null;
      config = YAML.parse(configText); // No try-catch: exception is ok to fall through to promise catch handler.

      const decompPath = config.decomposition;
      if (decompPath == null) {
        throw new Error('Fudomo transformation config file error: "decomposition" attribute not set.');
      }
      const decompFile = baseDir.getFile(decompPath);
      const decompPromise = decompFile.read(true);

      const funcPath = config.functions;
      if (funcPath == null) {
        throw new Error('Fudomo transformation config file error: "functions" attribute not set.');
      }
      const funcFile = baseDir.getFile(funcPath);
      const funcPromise = funcFile.read(true);

      const dataPath = config.data;
      if (dataPath == null) {
        throw new Error('Fudomo transformation config file error: "data" attribute not set.');
      }
      const dataFile = baseDir.getFile(dataPath);
      const dataFilePath = dataFile.getPath();

      const outputPath = config.output;
      if (outputPath == null) {
        throw new Error('Fudomo transformation config file error: "output" attribute not set.');
      }

      let model = null;
      try {
        model = loadModel(dataFilePath);
      } catch(error) {
        showError(`Could not load data from "${dataPath}"`, `Error: ${error.message}`, 'Open', () => atom.workspace.open(dataFilePath));
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
          showError(`Could not load Fudomo decomposition functions from "${funcPath}"`, `Error: ${error.message}`, 'Open', () => atom.workspace.open(funcFile.getPath()));
          return;
        }

        const transformation = parseFudomo(decompSource);
        if (transformation.hasError) {
          const errorsMd = getTransformationErrorsAsMarkDown(transformation);
          atom.notifications.addError('Could not parse Fudomo decomposition definition from "' + decompPath + '"', {
            dismissable: true,
            description: errorsMd,
            buttons: [{
              text: 'Open',
              onDidClick: () => atom.workspace.open(decompFile.getPath())
            }]
          });
        } else {
          transformation.externalFunctions = functionsModule;
          log = indentLog = dedentLog = function() {};
          try {
            let result = transform(transformation, model, log, indentLog, dedentLog);
            const outputFile = baseDir.getFile(outputPath);
            outputFile.write(result).then(function(result) {

              if (config.postprocess != undefined) {

                // Kill already running post-processor for the given data file
                if (dataFilePath in runningPostprocessors) {
                  const pid = runningPostprocessors[dataFilePath];
                  killedPostprocessors[pid] = true;
                  treeKill(pid, 'SIGKILL');
                }

                // this part does not use promises because child_process.exec, in its promisified version in node 10,
                // does not give access to the ChildProcess, which we need to get the pid in order to kill it if it already runs.
                const busyMessageTitle = `Postprocessing result of Fudomo transformation "${config.decomposition}"`;
                const busyMessage = thiz.busySignalApi.reportBusy(busyMessageTitle);

                const child = child_process.exec(config.postprocess, { cwd: baseDir.getPath(), windowsHide: true }, function(error, stdout, stderr) {
                  busyMessage.setTitle(busyMessageTitle + ' (interrupted)');
                  busyMessage.dispose();

                  if (error == null) {
                    if (notifyOnSuccess) {
                      showSuccess(`Result of Fudomo transformation "${config.decomposition}" successfully written to "${config.output}" and post-processed.`);
                    }
                  } else {
                    if (child.pid in killedPostprocessors) {
                      // If process was killed because transformation was triggered again, don't show error message.
                      // Checking this using error.signal was not reliable.
                      delete killedPostprocessors[child.pid];
                    } else {
                      showError(`Error post-processing result of Fudomo transformation "${config.decomposition}".`, stderr || stdout);
                    }
                  }
                  delete runningPostprocessors[dataFilePath];
                });

                runningPostprocessors[dataFilePath] = child.pid;

              } else {
                if (notifyOnSuccess) {
                  showSuccess(`Result of Fudomo transformation "${config.decomposition}" successfully written to "${config.output}".`, 'Open', () => atom.workspace.open(outputFile.getPath()));
                }
              }
            }, function(error) {
              showError(`Could not write Fudomo transformation result to destination file "${outputPath}"`, `Error: ${error.message}`);
            });
          } catch(error) {
            showError('Could not run Fudomo transformation', `Error: ${error.message}`);
            return;
          }
        }
      }).catch(function(error) {
        showError('Could not read Fudomo decomposition or functions file', `Error: ${error.message}`);
      });
    }).catch(function(error) {
      showError('Could not read Fudomo transformation configuration file', `Error: ${error.message}`, 'Open', () => atom.workspace.open(configFile.getPath()));
    });
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
          atom.notifications.addError(`Could not parse Fudomo decomposition definition from "${path}"`, {
            dismissable: true,
            description: errorsMd,
            buttons: [{
              text: 'Open',
              onDidClick: () => atom.workspace.open(file.getPath())
            }]
          });
        } else {
          const skeletonSource = generateSkeletonModule(transformation);
          destFile.write(skeletonSource).then(function(result) {
            showSuccess(`Fudomo function skeletons for transformation "${file.getBaseName()}" successfully written to "${destFile.getBaseName()}".`, 'Open', () => atom.workspace.open(destFile.getPath()));
          }, function(error) {
            showError(`Could not write skeleton functions to destination file "${destFile.getPath()}"`, `Error: ${error.message}`);
          });
        }

      }).catch(function(error) {
        showError('Could not create skeleton functions for Fudomo transformation', `Error: ${error.message}`);
      });
    }
  }
}
