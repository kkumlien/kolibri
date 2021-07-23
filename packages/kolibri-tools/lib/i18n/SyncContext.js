// Import packages
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const traverse = require('ast-traverse');
const get = require('lodash/get');
const parseCsvSync = require('csv-parse/lib/sync');
const vueCompiler = require('vue-template-compiler');
const logging = require('../logging');
const { insertContent } = require('../vueTools');
const {
  getVueSFCName,
  parseAST,
  is$trs,
  isCreateTranslator,
  objectToAst,
  extractContext,
  printAST,
} = require('./astUtils');
const { writeSourceToFile } = require('./utils');

// Glob path patterns
// All JS files
const JS_GLOB = '/**/*.js';
// All Vue files
const VUE_GLOB = '/**/*.vue';

// -------------------- //
// Processing Functions //
// -------------------- //

function findObjectsWith$trs(scriptAST) {
  const objects = [];
  // Traverse the AST and update nodes.
  traverse(scriptAST, {
    pre: node => {
      if (node.type === 'ObjectExpression') {
        for (let property of node.properties) {
          if (is$trs(property)) {
            objects.push(node);
            break;
          }
        }
      }
    },
  });
  return objects;
}

function modifyTranslationObjectNode(node, namespace, definitions) {
  const key = node.key.name;

  const definition = definitions.find(o => o['Identifier'] === `${namespace}.${key}`);

  if (!definition) {
    return false;
  }

  // Only definitions with context have been preserved to this point
  // so we must have some context to add
  node.value = objectToAst(definition, node.value.type === 'TemplateLiteral');

  return true;
}

function modifyVueComponent$trs(vueComponent, definitions) {
  let fileHasChanged = false;
  const namespace = getVueSFCName(vueComponent);

  definitions = definitions.filter(o => o['Identifier'].startsWith(namespace));
  // Traverse the AST and update nodes.
  traverse(vueComponent, {
    pre: node => {
      if (is$trs(node)) {
        // node.value.properties is the object passed to $trs
        for (let property of node.value.properties) {
          fileHasChanged =
            modifyTranslationObjectNode(property, namespace, definitions) || fileHasChanged;
        }
      }
    },
  });
  return fileHasChanged;
}

function modify$trASTNodes(scriptAST, definitions) {
  const vueComponents = findObjectsWith$trs(scriptAST);
  return vueComponents.map(vc => modifyVueComponent$trs(vc, definitions)).some(Boolean);
}

function modifyCreateTranslatorASTNodes(ast, definitions) {
  let fileHasChanged = false;
  // Traverse the AST and update nodes.
  traverse(ast, {
    pre: node => {
      // We only consider updating the node if it is a call to createTranslator()
      if (isCreateTranslator(node)) {
        // The first argument to createTranslator() is the namespace
        const namespace = node.arguments[0].value;

        const translatorDefinitions = definitions.filter(o =>
          o['Identifier'].startsWith(namespace)
        );
        if (namespace && node.arguments[1].properties) {
          // Go through all of the properties and update the nodes as needed.
          for (let property of node.arguments[1].properties) {
            fileHasChanged =
              modifyTranslationObjectNode(property, namespace, translatorDefinitions) ||
              fileHasChanged;
          }
        }
      }
    },
  });
  return fileHasChanged;
}

function processVueFiles(files, definitions) {
  return files
    .map(filePath => {
      const file = fs.readFileSync(filePath);

      // Parse into a SFCDescriptor (includes <template>, <script>, and <style> content)
      const vueSFC = vueCompiler.parseComponent(file.toString(), {
        preserveWhiteSpace: true,
        whitespace: 'preserve',
      });

      let scriptContent = get(vueSFC, 'script.content');

      // If we don't have a script, nothing to modify so stop here.
      if (!scriptContent) {
        return;
      }

      // Create an AST of the <script> code.
      const scriptAST = parseAST(scriptContent);

      let fileHasChanged = modify$trASTNodes(scriptAST, definitions);

      fileHasChanged = fileHasChanged || modifyCreateTranslatorASTNodes(scriptAST, definitions);

      // No need to write the file if it hasn't changed.
      if (fileHasChanged) {
        const newFile = insertContent(file.toString(), vueSFC.script, printAST(scriptAST));
        logging.info(`Updating context in ${filePath}`);
        return { newFile, filePath };
      }
    })
    .filter(Boolean);
}

function processJSFiles(files, definitions) {
  return files
    .map(filePath => {
      const file = fs.readFileSync(filePath);

      const ast = parseAST(file);

      const fileHasChanged = modifyCreateTranslatorASTNodes(ast, definitions);

      // No need to rewrite the file if we didn't modify it.
      if (fileHasChanged) {
        const newFile = printAST(ast);
        logging.info(`Updating context in ${filePath}`);
        return { newFile, filePath };
      }
    })
    .filter(Boolean);
}

// Compile all of the defined strings & context from the CSVs that have been downloaded
// from Crowdin.
function parseCSVDefinitions(dir) {
  return glob.sync(path.join(dir, '**/*.csv')).reduce((acc, filePath) => {
    const csvFile = fs.readFileSync(filePath).toString();

    return [...acc, ...parseCsvSync(csvFile, { skip_empty_lines: true, columns: true })];
  }, []);
}

module.exports = function(dryRun, dump, pathInfo, ignore) {
  logging.info('Transferring context...');

  // An object for storing our updated files.
  const updatedFiles = [];
  // Get a unique set of locale file paths to look for CSV files in
  const localFilePaths = Array.from(new Set(pathInfo.map(pathData => pathData.localeFilePath)));
  const csvDefinitions = localFilePaths
    .reduce((acc, filePath) => {
      return [
        ...acc,
        ...parseCSVDefinitions(
          path.join(
            path.dirname(path.dirname(filePath)),
            // Grab all downloaded CSV files so we don't have to play whackamole trying to work out
            // which language actually has all the included context in the exported CSV files.
            'CSV_FILES'
          )
        ),
      ];
    }, [])
    .filter(definition => definition['Context'] && extractContext(definition['Context']) !== '');

  if (!csvDefinitions.length) {
    logging.error('No context data was found in CSV files');
    process.exit(1);
  }

  for (let pathData of pathInfo) {
    logging.info(`Updating context for all files in ${pathData.moduleFilePath}`);
    // Load the files
    const vueFiles = glob.sync(path.join(pathData.moduleFilePath, VUE_GLOB), { ignore });
    const jsFiles = glob.sync(path.join(pathData.moduleFilePath, JS_GLOB), { ignore });

    // Get the updated files
    const vueFilesToWrite = processVueFiles(vueFiles, csvDefinitions);
    logging.info(
      `Parsed ${vueFiles.length} Vue components, added context to ${vueFilesToWrite.length}`
    );
    updatedFiles.push(...vueFilesToWrite);

    const jsFilesToWrite = processJSFiles(jsFiles, csvDefinitions);
    logging.info(`Parsed ${jsFiles.length} JS files, added context to ${jsFilesToWrite.length}`);
    updatedFiles.push(...jsFilesToWrite);
  }

  if (!dryRun) {
    // Write the updated files
    updatedFiles.forEach(fileObj => {
      writeSourceToFile(fileObj.filePath, fileObj.newFile);
    });
  }

  if (dump) {
    const timestamp = Math.floor(Date.now() / 1000);
    writeSourceToFile(
      `updatedContextFiles-${timestamp}.txt`,
      updatedFiles.reduce((acc, fileObj) => {
        return acc + fileObj.filePath + '\n' + fileObj.newFile + '\n\n';
      })
    );
    logging.info(
      `--dump-extracted --> source files with updated context dumped to updatedContextFiles-${timestamp}.txt`
    );
  }

  logging.info('Context transfer has completed!');
};
