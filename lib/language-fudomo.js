'use babel';

import { CompositeDisposable, File } from 'atom'
import { VM } from 'vm2'
import YAML from 'yaml'

import { parseFudomo, loadModel, transform, generateSkeletonModule, MetamodelInferer, TransformationValidator } from 'fudomo-transform' // TODO use ES6 modules
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

function hasFileExtension(event, extension) { // extension can be single extension or array
  // The click was on an element in li.file, find the li itself
  let listItem = null;
  for (const element of event.path.filter((o) => o instanceof HTMLElement)) {
    if (element.matches('.tree-view .file')) {
      listItem = element;
      break;
    }
  }

  const extensions = Array.isArray(extension) ? extension : [extension];

  for (const ext of extensions) {
    // Check if the li is for a file that has the right kind of name
    // by looking for the span inside it with the matching data-name attribute.
    if (listItem != null && listItem.querySelector('.name[data-name$=".' + ext + '"]') != null) {
      return true;
    }
  }
  return false;
}

function getSelectedFilesWithExtension(treeView, extension) { // extension can be string or array
  const extensions = Array.isArray(extension) ? extension : [extension];
  const candidatePaths = treeView.selectedPaths();
  const paths = [];
  for (const path of candidatePaths) {
    for (const ext of extensions) {
      if (path.endsWith('.' + ext)) {
        paths.push(path);
      }
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

const runningPostprocessors = {}; // key is absolute path of config file, value is pid
const killedPostprocessors = {}; // key is pid, value is dummy

class Phase {
  constructor(activity, openablePath) {
    this.activity = activity;
    this.openablePath = openablePath;
  }
}

export default {
  subscriptions: null,
  treeView: null,
  busySignalApi: null,
  indieLinter: null,

  activate() {
    this.subscriptions = new CompositeDisposable();

    // Add command for running transformation
    this.subscriptions.add(atom.commands.add('atom-workspace', {
      'language-fudomo:runTransformation': () => this.runTransformation(),
      'language-fudomo:validateTransformation': () => this.validateTransformation(),
      'language-fudomo:generateFunctions': () => this.generateFunctions(),
      'language-fudomo:inferMetamodel': () => this.inferMetamodel(),
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
        { 'label': 'Validate Fudomo Transformation',
          'command':  'language-fudomo:validateTransformation',
          'shouldDisplay': event => hasFileExtension(event, CONFIG_FILE_EXTENSION)
        },
        { 'label': 'Infer Metamodel',
          'command':  'language-fudomo:inferMetamodel',
          'shouldDisplay': event => hasFileExtension(event, ['yaml', 'oyaml', 'js']) // TODO get extensions from model-io.js
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
    this.subscriptions.add(atom.project.onDidChangeFiles(async events => {
      const autoTransformPaths = Object.keys(atom.config.get('language-fudomo.autoTransformPaths') || {});
      if (autoTransformPaths.length == 0) return;

      const dataFileAbsPaths = {}; // maps to set of config file paths
      for (var configPath of autoTransformPaths) {
        try {
          // Use of await in for-loop instead of Promise.all() is deliberate, because we don't want to fail fast.
          if (atom.project.relativizePath(configPath) == null) continue; // Not in open project
          const configText = await new File(configPath).read(true);
          const config = YAML.parse(configText);
          const dataFile = new File(configPath).getParent().getFile(config.data);
          const resolvedDataFilePath = await dataFile.getRealPath();
          configPaths = dataFileAbsPaths[resolvedDataFilePath];
          if (configPaths === undefined) {
            configPaths = new Set();
            dataFileAbsPaths[resolvedDataFilePath] = configPaths;
          }
          configPaths.add(configPath);
        } catch (error) {
          showError('Error running Auto Transform', error.message);
        }
      }

      for (const event of events) {
        const action = event.action;
        if (action == 'created' || action == 'modified' || action == 'renamed') {
          const configPaths = dataFileAbsPaths[event.path] || [];
          for (const configPath of configPaths) {
            thiz.runTransformationConfigFile(configPath, notifyOnSuccess = false);
          }
        }
      }
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

  consumeIndie(registerIndie) {
    const linter = registerIndie({
      name: 'Fudomo Transformation Validator',
    });
    this.subscriptions.add(linter);
    this.indieLinter = linter;
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

  async runTransformation() {
    const paths = getSelectedFilesWithExtension(this.treeView, CONFIG_FILE_EXTENSION);
    await Promise.all(paths.map(async (path) => this.runTransformationConfigFile(path, true)));
  },

  async runTransformationConfigFile(path, notifyOnSuccess = true) {
    const thiz = this;
    const configFile = new File(path);
    const baseDir = configFile.getParent();
    let phase = new Phase('reading config file', path); // for error handler
    try {
      const configText = await configFile.read(true);
      let config = null;
      phase = new Phase('parsing config file', path);
      config = YAML.parse(configText); // No try-catch: exception is ok to fall through to outer catch handler.

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

      phase = new Phase(`loading data from "${dataPath}"`, dataFilePath);
      const model = loadModel(dataFilePath);

      phase = 'loading decomposition or functions file';
      const parts = await Promise.all([decompPromise, funcPromise]);
      const [decompSource, functionSource] = parts;

      phase = new Phase(`parsing Fudomo decomposition functions from "${funcPath}"`, funcFile.getPath());
      const vm = new VM({
          sandbox: { 'module': {} }
      });
      let functionsModule = vm.run(functionSource);

      const transformation = parseFudomo(decompSource);
      if (transformation.hasError) {
        const errorsMd = getTransformationErrorsAsMarkDown(transformation);
        atom.notifications.addError(`Could not parse Fudomo decomposition definition from "${decompPath}"`, {
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

        phase = new Phase(`running Fudomo transformation ${config.decomposition}`, decompFile.getPath());
        let result = transform(transformation, model, log, indentLog, dedentLog);

        phase = `writing Fudomo transformation result to destination file "${outputPath}"`;
        const outputFile = baseDir.getFile(outputPath);
        await outputFile.write(result);

        if (config.postprocess != undefined) {

          // Kill already running post-processor for the given config file
          if (path in runningPostprocessors) {
            const pid = runningPostprocessors[path];
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
                showError(`Error post-processing result of Fudomo transformation "${config.decomposition}".`, stderr || stdout, 'Open', () => atom.workspace.open(dataFilePath));
              }
            }
            delete runningPostprocessors[path];
          });

          runningPostprocessors[path] = child.pid;

        } else {
          if (notifyOnSuccess) {
            showSuccess(`Result of Fudomo transformation "${config.decomposition}" successfully written to "${config.output}".`, 'Open', () => atom.workspace.open(outputFile.getPath()));
          }
        }
      }
    } catch (error) {
      let activity = phase;
      let openablePath = null;
      if (phase instanceof Phase) {
        activity = phase.activity;
        openablePath = phase.openablePath;
      }
      if (openablePath !== null) {
        showError(`Error while ${activity}`, `Error: ${error.message}`, 'Open', () => atom.workspace.open(openablePath));
      } else {
        showError(`Error while ${activity}`, `Error: ${error.message}`);
      }
    }
  },

  async generateFunctions() {
    const paths = getSelectedFilesWithExtension(this.treeView, FUDOMO_FILE_EXTENSION);
    await Promise.all(paths.map(this.generateFunctionsForDecompositionFile));
  },

  async generateFunctionsForDecompositionFile(path) {
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

    try {
      const decompSource = await file.read(true);
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
        try {
          await destFile.write(skeletonSource);
          showSuccess(`Fudomo function skeletons for transformation "${file.getBaseName()}" successfully written to "${destFile.getBaseName()}".`, 'Open', () => atom.workspace.open(destFile.getPath()));
        } catch (error) {
          showError(`Could not write skeleton functions to destination file "${destFile.getPath()}"`, `Error: ${error.message}`);
        }
      }

    } catch(error) {
      showError('Could not create skeleton functions for Fudomo transformation', `Error: ${error.message}`);
    }
  },

  async inferMetamodel() {
    const paths = getSelectedFilesWithExtension(this.treeView, ['oyaml', 'yaml', 'js']); // TODO get extensions from model-io.js
    if (paths.length == 0) return;

    const parents = paths.map(path => new File(path).getParent());
    parents.sort((a, b) => b.getPath().length - a.getPath().length); // Sort by length
    const destDir = parents[0];
    const destFile = destDir.getFile('Metamodel.yaml');

    try {
      const metamodel = new MetamodelInferer().inferMetamodelFromPaths(paths);
      const textualMetamodel = YAML.stringify(metamodel);
      await destFile.write(textualMetamodel);
      showSuccess(`Inferred metamodel written to "${destFile.getBaseName()}"`, 'Open', () => atom.workspace.open(destFile.getPath()));
    } catch (error) {
      showError('Error inferring metamodel', `Error: ${error.message}`);
    }
  },

  async validateTransformation() {
    const paths = getSelectedFilesWithExtension(this.treeView, 'config');

    for (const configPath of paths) {
      try {
        const configFile = new File(configPath);
        const configText = await configFile.read(true);
        const config = YAML.parse(configText);

        if (config.metamodel == null) {
          throw new Error('Configuration file does not specify metamodel.');
        }

        const parentDir = configFile.getParent();
        const metamodelFile = parentDir.getFile(config.metamodel);

        const metamodelText = await metamodelFile.read(true);
        const metamodel = YAML.parse(metamodelText);

        if (config.decomposition == null) {
          throw new Error('Configuration file does not specify decomposition.')
        }

        const decompFile = parentDir.getFile(config.decomposition);
        const transformationText = await decompFile.read(true);
        const transformation = parseFudomo(transformationText);

        const validator = new TransformationValidator(metamodel, transformation);

        const messages = [];
        for (const error of validator.errors) {

          messages.push({
            severity: 'error',
            location: {
              file: decompFile.getPath(),
              position: error.location
            },
            excerpt: error.message,
            description: error.context
          });
        }
        this.indieLinter.setMessages(decompFile.getPath(), messages);

      } catch (error) {
        showError('Error validating Transformation', `Error: ${error.message}`);
      }

    }
  }
}
