'use babel';

import { CompositeDisposable, File } from 'atom'
import YAML from 'yaml'
import { nullOptions } from 'yaml/types'
import path from 'path'
import process from 'process'

import { parseFudomo, loadModel, transform, TransformationContext, getRunnerClassById, getRunnerClassByFileExtension, getSkeletonGenerator, SKELETON_GENERATORS, MetamodelInferer, TransformationValidator, DataValidator, FudomoComputeException } from 'fudomo-transform' // TODO use ES6 modules
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

function showFudomoComputeException(error, basePath) {
  const options = {
    dismissable: true,
    description: error.toHtml(basePath)
  };

  if (error.cause.constructor.name === 'UnsupportedPythonVersionError') {
    options.description =
    `# Error: Unsupported Python version

${error.cause.version} was found, but Python 3 is required.

Please specify a corresponding \`python3\` interpreter executable in the decomposition config file, using
one of the following keys:

- \`python-executable\`: path to executable file
- \`python-executable-<platform>\`: path to executable file to use on &lt;platform&gt;, where platform can be
  one of aix, darwin, freebsd, linux, openbsd, sunos, win32 (current platform: ${process.platform}).
    `;
  }

  atom.notifications.addError('An error occurred running the Fudomo transformation', options);
  for (const link of document.querySelectorAll('atom-notification a.fudomo-exception-source-link')) {
    link.onclick = (event) => {
      const location = JSON.parse(event.srcElement.getAttribute('data-source-loc'));
      const editorPromise = atom.workspace.open(location.src, { initialLine: Number(location.pos[0][0]), initialColumn: Number(location.pos[0][1]) });
      editorPromise.then(editor => {
        editor.setSelectedBufferRange(location.pos);
      });
    };
  }
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

let lastCopyDecompositionFunctionContextMenuMouseEvent = null;

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
    require('atom-package-deps').install('language-fudomo');

    this.subscriptions = new CompositeDisposable();

    // Add command for running transformation
    const commands = {
      'language-fudomo:runTransformation': () => this.runTransformation(),
      'language-fudomo:validateTransformation': () => this.validateTransformation(),
      'language-fudomo:validateData': () => this.validateData(),
      'language-fudomo:inferMetamodel': () => this.inferMetamodel(),
      'language-fudomo:enableAutoTransform': () => this.enableAutoTransform(),
      'language-fudomo:disableAutoTransform': () => this.disableAutoTransform()
    };
    for (const language of SKELETON_GENERATORS) {
      commands[`language-fudomo:generateFunctions-${language.id}`] = () => this.generateFunctions(language.id);
      commands[`language-fudomo:copyDecompositionFunctionDefinition-${language.id}`] = () => this.copyDecompositionFunctionDefinition(language.id);
    }
    this.subscriptions.add(atom.commands.add('atom-workspace', commands));

    const skeletonGenerationSubMenus = [];
    for (const language of SKELETON_GENERATORS) {
      skeletonGenerationSubMenus.push({
        label: language.name,
        command: `language-fudomo:generateFunctions-${language.id}`
      });
    }
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
        { 'label': 'Validate Data File',
          'command':  'language-fudomo:validateData',
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
          'shouldDisplay': event => hasFileExtension(event, FUDOMO_FILE_EXTENSION),
          'submenu': skeletonGenerationSubMenus
        }
      ],
      '.syntax--entity.syntax--name.syntax--section.syntax--decomposition.syntax--fudomo': [
        { label: 'Copy Decomposition Function',
          created: function(event) {
            lastCopyDecompositionFunctionContextMenuMouseEvent = event;
          },
          submenu: SKELETON_GENERATORS.map(language => { return { label: language.name, command: `language-fudomo:copyDecompositionFunctionDefinition-${language.id}` } })
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
          if (configText === null) continue;
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

  async runTransformationConfigFile(configFilePath, notifyOnSuccess = true) {
    const thiz = this;
    const configFile = new File(configFilePath);
    const projectPath = atom.project.relativizePath(configFilePath)[0];
    const baseDir = configFile.getParent();
    let phase = new Phase('reading config file', configFilePath); // for error handler

    let funcFile = null;
    let dataFile = null;
    let decompFile = null;

    try {
      const configText = await configFile.read(true);
      if (configText === null) throw new Error('Config file not found.');
      let config = null;
      phase = new Phase('parsing config file', configFilePath);
      config = YAML.parse(configText); // No try-catch: exception is ok to fall through to outer catch handler.

      const decompPath = config.decomposition;
      if (decompPath === undefined) {
        throw new Error('Fudomo transformation config file error: "decomposition" attribute not set.');
      }
      decompFile = baseDir.getFile(decompPath);

      const funcPath = config.functions;
      if (funcPath === undefined) {
        throw new Error('Fudomo transformation config file error: "functions" attribute not set.');
      }
      funcFile = baseDir.getFile(funcPath);
      const funcPromise = funcFile.read(true);

      const dataPath = config.data;
      if (dataPath === undefined) {
        throw new Error('Fudomo transformation config file error: "data" attribute not set.');
      }
      dataFile = baseDir.getFile(dataPath);
      const dataFilePath = dataFile.getPath();

      const outputPath = config.output;
      if (outputPath === undefined) {
        throw new Error('Fudomo transformation config file error: "output" attribute not set.');
      }

      phase = new Phase(`loading data from "${dataPath}"`, dataFilePath);
      const model = loadModel(dataFilePath);

      phase = 'loading decomposition file';
      const decompSource = await decompFile.read(true);
      if (decompSource == null) throw new Error('Decomposition file not found.');

      phase = new Phase(`creating decomposition function runner`, configFile.getPath());
      let RunnerClass = null;
      if (config.runnerId !== undefined) {
        // Runner is configured in config file
        if (config.runnerId === 'javascript') {
          // Automatically substitute javascriptvm for javascript, because
          // we don't want to run user-supplied js code in Atom's node directly.
          RunnerClass = getRunnerClassById('javascriptvm');
        } else {
          RunnerClass = getRunnerClassById(config.runnerId);
        }
      } else {
        // Runner is not configured in config file, find by file extension
        const extension = path.extname(config.functions).slice(1);
        if (extension === 'js') {
          // Automatically use javascriptvm for javascript, because
          // we don't want to run user-supplied js code in Atom's node directly.
          RunnerClass = getRunnerClassById('javascriptvm');
        } else {
          RunnerClass = getRunnerClassByFileExtension(extension);
        }
      }
      if (RunnerClass == undefined) {
        if (config.runnerId !== undefined) {
          throw new Error(`Can not find decomposition function runner class with id "${config.runnerId}".`);
        } else {
          throw new Error(`Can not find decomposition function runner class for file extension "${path.extname(config.functions).slice(1)}".`);
        }
      }

      phase = new Phase(`parsing Fudomo decomposition functions from "${funcPath}"`, funcFile.getPath());
      config.functions = await funcFile.getRealPath(); // Set config.functions to absolute path (non-permanent change as the loaded config instance is only used in this function)
      config.consoleHandler = console;
      const functionRunner = new RunnerClass(baseDir.getPath(), config);

      const absDecompPath = await decompFile.getRealPath();
      const transformation = parseFudomo(decompSource, absDecompPath);
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
        phase = new Phase(`running Fudomo transformation ${config.decomposition}`, decompFile.getPath());
        const transformationContext = new TransformationContext(transformation, model, functionRunner);
        transform(transformationContext).then(async result => {

          try {
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
          } catch (error) {
            this.handleTransformError(error, phase, projectPath);
          }
        }).catch(error => {
          this.handleTransformError(error, phase, projectPath);
        });
      }
    } catch (error) {
      this.handleTransformError(error, phase, projectPath);
    }
  },

  handleTransformError(error, phase, projectPath) {
    console.dir(error);
    if (error instanceof FudomoComputeException) {
      showFudomoComputeException(error, projectPath);
      return;
    }

    let activity = phase;
    let openablePath = null;
    if (phase instanceof Phase) {
      activity = phase.activity;
      openablePath = phase.openablePath;
    }

    if (openablePath !== null) {
      showError(`Error while ${activity}`, `Error: ${error.message}\nStack trace:\n${error.toString()}`, 'Open', () => atom.workspace.open(openablePath));
    } else {
      showError(`Error while ${activity}`, `Error: ${error.message}`);
    }
  },

  async generateFunctions(languageId) {
    const paths = getSelectedFilesWithExtension(this.treeView, FUDOMO_FILE_EXTENSION);
    await Promise.all(paths.map(path => this.generateFunctionsForDecompositionFile(path, languageId)));
  },

  async copyDecompositionFunctionDefinition(languageId) {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) {
      return;
    }

    const mouseEvent = lastCopyDecompositionFunctionContextMenuMouseEvent;
    if (mouseEvent == null) {
      return;
    }

    const screenPos = editor.component.screenPositionForMouseEvent(mouseEvent);
    const bufferPos = editor.bufferPositionForScreenPosition(screenPos);
    const transformation = parseFudomo(editor.getBuffer().getText());
    if (transformation.hasError) {
      showError('Can not copy decomposition function definition: the transformation file has errors.');
      return;
    }

    const decomposition = transformation.getDecompositionForTextCoordinate(bufferPos.column, bufferPos.row);
    if (!decomposition) {
      return;
    }

    const generator = getSkeletonGenerator(languageId);
    const functionDefinition = generator.generateDecompositionFunction(decomposition);
    atom.clipboard.write(functionDefinition);
    showSuccess(`Skeleton function definition of "${decomposition.function.qualifiedName}" copied to clipboard.`);
  },

  async generateFunctionsForDecompositionFile(path, languageId) {
    const language = SKELETON_GENERATORS.filter(g => g.id == languageId)[0];

    const file = new File(path);
    const dir = file.getParent();

    // Calculate destination file name like this: 'abc.fudomo' => 'abc_functions.js', 'abc_functions2.js', 'abc_functions3.js', ...
    const filenameNoExt = file.getBaseName().slice(0, -(FUDOMO_FILE_EXTENSION.length + 1));
    let dedupSuffix = '';
    let destFile = dir.getFile(filenameNoExt + '_functions' + String(dedupSuffix) + '.' + language.extension);
    while (destFile.existsSync()) {
      if (dedupSuffix == '') {
        dedupSuffix = 2;
      }
      destFile = dir.getFile(filenameNoExt + '_functions' + String(dedupSuffix) + '.' + language.extension);
      dedupSuffix += 1;
    }

    try {
      const decompSource = await file.read(true);
      if (decompSource === null) throw new Error('Decomposition file not found.');

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
        const skeletonSource = getSkeletonGenerator(language.id).generateSkeleton(transformation);
        try {
          await destFile.write(skeletonSource);
          showSuccess(`Fudomo function skeletons for transformation "${file.getBaseName()}" successfully written to "${destFile.getBaseName()}".`, 'Open', () => atom.workspace.open(destFile.getPath()));
        } catch (error) {
          showError(`Could not write skeleton functions to destination file "${destFile.getPath()}"`, `Error: ${error.message}`);
        }
      }

    } catch(error) {
      showError('Could not create skeleton functions for Fudomo transformation', `Error: ${error.message}`);
      console.dir(error);
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
      nullOptions.nullStr = '';
      const textualMetamodel = YAML.stringify(metamodel);
      await destFile.write(textualMetamodel);
      showSuccess(`Inferred metamodel written to "${destFile.getBaseName()}"`, 'Open', () => atom.workspace.open(destFile.getPath()));
    } catch (error) {
      showError('Error inferring metamodel', `Error: ${error.message}`);
      console.dir(error);
    }
  },

  async validateTransformation() {
    const paths = getSelectedFilesWithExtension(this.treeView, 'config');

    for (const configPath of paths) {
      try {
        const configFile = new File(configPath);
        const configText = await configFile.read(true);
        if (configText === null) throw new Error('Config file not found.');
        const config = YAML.parse(configText);

        if (config.metamodel == null) {
          throw new Error('Configuration file does not specify metamodel.');
        }

        const parentDir = configFile.getParent();
        const metamodelFile = parentDir.getFile(config.metamodel);

        const metamodelText = await metamodelFile.read(true);
        if (metamodelText === null) {
          throw new Error(`Metamodel file ${metamodelFile.getPath()} could not be read.`);
        }
        const metamodel = YAML.parse(metamodelText);

        if (config.decomposition == null) {
          throw new Error('Configuration file does not specify decomposition.');
        }

        const decompFile = parentDir.getFile(config.decomposition);
        const transformationText = await decompFile.read(true);
        if (transformationText === null) throw new Error('Decomposition file not found.');
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
        console.dir(error);
      }

    }
  },

  async validateData() {
    const paths = getSelectedFilesWithExtension(this.treeView, 'config');

    for (const configPath of paths) {
      try {
        const configFile = new File(configPath);
        const configText = await configFile.read(true);
        if (configText === null) throw new Error('Config file not found.');
        const config = YAML.parse(configText);

        const parentDir = configFile.getParent();
        let metamodel = null;
        if (config.metamodel != null) {
          const metamodelFile = parentDir.getFile(config.metamodel);

          const metamodelText = await metamodelFile.read(true);
          if (metamodelText === null) {
            throw new Error(`Metamodel file ${metamodelFile.getPath()} could not be read.`);
          }
          metamodel = YAML.parse(metamodelText);
        }

        if (config.data == null) {
          throw new Error('Configuration file does not specify data.')
        }

        // Load data and catch syntactic errors
        const dataFile = parentDir.getFile(config.data);
        let model = null;
        let errors = [];
        try {
          model = loadModel(dataFile.getPath());
        } catch (error) {
          if (error.markers != undefined) {
            errors = error.markers;
          } else {
            throw error;
          }
        }

        // Run data validation if no syntactic errors were found
        if (model !== null && metamodel !== null) {
          const validator = new DataValidator(metamodel, model);
          errors = errors.concat(validator.errors);
        }

        const messages = [];
        for (const error of errors) {
          messages.push({
            severity: 'error',
            location: {
              file: dataFile.getPath(),
              position: error.location
            },
            excerpt: error.message,
            description: error.context
          });
        }
        this.indieLinter.setMessages(dataFile.getPath(), messages);

      } catch (error) {
        showError('Error validating data file', `Error: ${error.message}`);
        console.dir(error);
      }
    }
  }
}
