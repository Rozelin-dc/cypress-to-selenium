// @ts-check
const ts = require('typescript')
const fs = require('fs')
const path = require('path')

const ORIGINAL_DRIVER_CLASS_NAME = 'OriginalWebDriver'
const PACKAGE_NAME = 'test'
const OUTPUT_DIR = './output'
const ORIGINAL_COMMAND_LIST_FILE = './output/commands.txt'
const ORIGINAL_COMMAND_LIST = fs.existsSync(ORIGINAL_COMMAND_LIST_FILE)
  ? fs.readFileSync(ORIGINAL_COMMAND_LIST_FILE, 'utf-8').split('\n')
  : []

/**
 * @param {string} raw
 * @returns {string}
 */
function escapeJavaString(raw) {
  return raw.replace(/^'(.*)'$/g, '$1').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/**
 * @typedef {{ method: string, args: ts.NodeArray<ts.Expression> }} ChainItem
 */
/**
 * @param {ts.CallExpression} callExpr
 * @returns {ChainItem[]}
 */
function extractCyChain(callExpr) {
  /** @type {ChainItem[]} */
  const chain = []
  /** @type {ts.Node} */
  let current = callExpr

  while (ts.isCallExpression(current)) {
    const expr = current.expression
    if (ts.isPropertyAccessExpression(expr)) {
      chain.unshift({ method: expr.name.getText(), args: current.arguments })
      current = expr.expression
    } else if (ts.isIdentifier(expr)) {
      chain.unshift({ method: expr.getText(), args: current.arguments })
      break
    } else {
      break
    }
  }

  return chain
}

let tempVarIndex = 0
/**
 * @param {ChainItem[]} chain
 * @param {string} driverName
 * @returns {string}
 */
function convertCyChainToJava(chain, driverName = 'driver') {
  let expr = `${driverName}`

  for (let i = 0; i < chain.length; i++) {
    const { method, args } = chain[i]
    switch (method) {
      case 'contains': {
        if (i != 0 && i === chain.length - 1) {
          // The last contains in the chain is considered an assertion.
          const argText = args[0].getText()
          expr = `WebElement element${tempVarIndex} = ${expr};\n`
          expr += `    AssertJUnit.assertTrue(element${tempVarIndex}.getText().contains("${escapeJavaString(
            argText
          )}"));`
          tempVarIndex++
          break
        }
      }
      case 'get':
      case 'find': {
        const argText = args[0].getText()
        let selectorExpr = `By.cssSelector("${escapeJavaString(argText)}")`
        if (method === 'contains') {
          selectorExpr = `By.xpath("//*[contains(text(), '${escapeJavaString(
            argText
          )}')]")`
        }
        expr += `.findElement(${selectorExpr})`
        break
      }
      case 'click': {
        expr += '.click()'
        break
      }
      case 'type': {
        const typeText = ts.isStringLiteral(args[0])
          ? `"${escapeJavaString(args[0].text)}"`
          : args[0].getText()
        expr += `.sendKeys(${typeText})`
        break
      }
      case 'should': {
        const condition = args[0].getText()
        if (condition === 'be.visible') {
          return `AssertJUnit.assertTrue(${expr}.isDisplayed());`
        } else if (condition === 'not.be.visible') {
          return `AssertJUnit.assertFalse(${expr}.isDisplayed());`
        }
        break
      }
      case 'visit': {
        const url = ts.isStringLiteral(args[0])
          ? `"${escapeJavaString(args[0].text)}"`
          : args[0].getText()
        expr += `.get(${url})`
        break
      }
      case 'first':
      case 'last':
      case 'eq': {
        expr = expr.replace(/(.*)\.findElement/, '$1.findElements')
        if (method === 'last') {
          expr = `List<WebElement> elements${tempVarIndex} = ${expr};\n`
          expr += `    elements${tempVarIndex}.get(elements${tempVarIndex}.size() - 1)`
          tempVarIndex++
        } else {
          const index = method === 'eq' ? args[0].getText() : '0'
          expr += `.get(${index})`
        }
        break
      }
      case 'request': {
        const [options] = args
        if (i === 0) {
          expr = ''
        } else {
          expr += `;\n    `
        }
        if (ts.isStringLiteral(options)) {
          expr += `HttpURLConnection conn = (HttpURLConnection) new URL(${options.getText()}).openConnection();\n`
          expr += `    conn.setRequestMethod("GET");`
        } else if (ts.isObjectLiteralExpression(options)) {
          const urlProp = options.properties.find(
            (p) => p.name?.getText() === 'url'
          )
          const methodProp = options.properties.find(
            (p) => p.name?.getText() === 'method'
          )
          const url =
            urlProp && ts.isPropertyAssignment(urlProp)
              ? urlProp.initializer.getText()
              : '"http://localhost"'
          const method =
            methodProp && ts.isPropertyAssignment(methodProp)
              ? methodProp.initializer.getText().replace(/['"]/g, '')
              : 'GET'
          expr += `HttpURLConnection conn = (HttpURLConnection) new URL(${url}).openConnection();\n`
          expr += `    conn.setRequestMethod("${method.toUpperCase()}");`
        } else {
          expr += `/* unsupported request syntax */`
        }
        break
      }
      case 'then': {
        const cb = args[0]
        if (ts.isFunctionLike(cb)) {
          const body = cb.body
          const innerStatements = []
          ts.forEachChild(body, (child) => {
            if (
              ts.isExpressionStatement(child) &&
              ts.isCallExpression(child.expression)
            ) {
              const innerChain = extractCyChain(child.expression)
              innerStatements.push(convertCyChainToJava(innerChain, driverName))
            }
          })
          expr += `;\n` + innerStatements.map((s) => '    ' + s).join('\n')
        } else {
          expr += `/* unsupported then syntax */`
        }
        break
      }
      case 'within': {
        const cb = args[0]
        const parentSelector = expr
        const tempVar = `scopeElement${tempVarIndex++}`
        if (ts.isFunctionLike(cb)) {
          const body = cb.body
          const innerStatements = []
          ts.forEachChild(body, (child) => {
            if (
              ts.isExpressionStatement(child) &&
              ts.isCallExpression(child.expression)
            ) {
              const chain = extractCyChain(child.expression)
              const scopedExpr = convertCyChainToJava(
                chain,
                driverName
              ).replace(driverName, tempVar)
              innerStatements.push(scopedExpr)
            }
          })
          expr = `WebElement ${tempVar} = ${parentSelector};
    ${innerStatements.join('\n    ')}
`
        }
        break
      }
      default: {
        if (ORIGINAL_COMMAND_LIST.includes(method)) {
          expr += `.${method}(`
          if (args.length > 0) {
            expr += args.map((arg) => arg.getText()).join(', ')
          }
          expr += ')'
          break
        }
        expr += `/* unsupported method: ${method} */`
      }
    }
  }

  return expr + ';'
}

/**
 * @param {ts.CallExpression} describeCall
 * @returns {{ className: string, javaCode: string }|null}
 */
function convertDescribeBlock(describeCall) {
  const [descArg, bodyFn] = describeCall.arguments
  if (!ts.isStringLiteral(descArg) || !ts.isFunctionLike(bodyFn)) {
    return null
  }

  const className = descArg.text.replace(/\s+/g, '') + 'Test'
  let output = `package ${PACKAGE_NAME};

import org.junit.*;
import org.openqa.selenium.*;
import org.testng.AssertJUnit;

`
  output += `public class ${className} {\n  WebDriver driver;\n\n`

  const BeforeOrAfter = {
    beforeEach: { annotation: '@Before', method: 'setup', exists: false },
    afterEach: { annotation: '@AfterMethod', method: 'end', exists: false },
    before: { annotation: '@BeforeClass', method: 'setupClass', exists: false },
  }

  /**
   * @param {ts.Node} node
   * @returns {void}
   */
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const fn = node.expression.getText()

      // beforeEach / afterEach / before
      if (
        Object.keys(BeforeOrAfter).includes(fn) &&
        node.arguments.length === 1
      ) {
        const annotation = BeforeOrAfter[fn].annotation
        const cb = node.arguments[0]
        if (ts.isFunctionLike(cb)) {
          const methodName = BeforeOrAfter[fn].method
          output += `  ${annotation}\n  public void ${methodName}() {\n`
          if (annotation === '@Before') {
            output += `    driver = new ${ORIGINAL_DRIVER_CLASS_NAME}();\n`
          } else if (annotation === '@After') {
            output += `    driver.quit();\n`
          }
          ts.forEachChild(cb.body, visit)
          output += '  }\n'
          BeforeOrAfter[fn].exists = true
        }
        return
      }

      // it()
      if ((fn === 'it' || fn === 'xit') && node.arguments.length === 2) {
        const [desc, cb] = node.arguments
        if (ts.isStringLiteral(desc) && ts.isFunctionLike(cb)) {
          const methodName = desc.text.replace(/\s+/g, '_')
          if (fn === 'xit') {
            output += `  @Ignore\n`
          }
          output += `  @Test\n  public void ${methodName}() {\n`
          ts.forEachChild(cb.body, visit)
          output += '  }\n'
        }
        return
      }

      // expect
      if (fn === 'expect' && node.arguments.length === 1) {
        const actual = node.arguments[0].getText()
        const parent = node.parent
        if (
          ts.isCallExpression(parent) &&
          ts.isPropertyAccessExpression(parent.expression)
        ) {
          const matcher = parent.expression.name.getText()
          const expected = parent.arguments[0]?.getText() ?? ''

          if (matcher === 'to.equal' || matcher === 'to.eq') {
            output += `    AssertJUnit.assertEquals(${expected}, ${actual});\n`
            return
          } else if (matcher === 'to.be.true') {
            output += `    AssertJUnit.assertTrue(${actual});\n`
            return
          } else if (matcher === 'to.be.false') {
            output += `    AssertJUnit.assertFalse(${actual});\n`
            return
          }
        }
      }

      // chain
      const chain = extractCyChain(node)
      if (chain.length > 0) {
        const javaCode = convertCyChainToJava(chain)
        output += `    ${javaCode}\n`
        return
      }
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(bodyFn.body, visit)

  // add @Before / @After if not exists
  if (!BeforeOrAfter.beforeEach.exists) {
    output += `  @Before\n  public void setup() {\n`
    output += `    driver = new ${ORIGINAL_DRIVER_CLASS_NAME}();\n  }\n`
  }
  if (!BeforeOrAfter.afterEach.exists) {
    output += `  @AfterMethod\n  public void end() {\n`
    output += `    driver.quit();\n  }\n`
  }

  output += '}\n'

  return { className, javaCode: output }
}

/**
 * @param {string} tsFileName
 * @param {string} tsCode
 * @returns {string[]}
 */
function convertCypressCommandsToJava(tsFileName, tsCode) {
  const sourceFile = ts.createSourceFile(
    tsFileName,
    tsCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )

  const methods = []
  ORIGINAL_COMMAND_LIST.splice(0)

  ts.forEachChild(sourceFile, (node) => {
    if (
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.expression.getText() === 'Cypress.Commands' &&
      node.expression.expression.name.getText() === 'add'
    ) {
      const [commandNameNode, functionNode] = node.expression.arguments

      if (!ts.isStringLiteral(commandNameNode)) {
        throw new Error('Command name must be a string literal')
      }
      if (
        !ts.isFunctionExpression(functionNode) &&
        !ts.isArrowFunction(functionNode)
      ) {
        throw new Error('Expected a function expression or arrow function')
      }

      const commandName = commandNameNode.text
      ORIGINAL_COMMAND_LIST.push(commandName)
      /** @type {ts.FunctionExpression|ts.ArrowFunction} */
      const func = functionNode

      const args = func.parameters.map((p) => `${p.name.getText()}`)
      const methodSignature = `public ${ORIGINAL_DRIVER_CLASS_NAME} ${commandName}(${args
        .map((a) => `String ${a}`)
        .join(', ')}) throws Exception {`

      /** @type {ReadonlyArray<ts.Node>} */
      let body = []
      if (ts.isBlock(func.body)) {
        body = func.body.statements
      } else {
        body = [func.body]
      }
      let javaBody = ''
      /**
       * @param {ts.Node} node
       * @returns {void}
       */
      function visit(node) {
        if (ts.isCallExpression(node)) {
          const chain = extractCyChain(node)
          const javaChain = convertCyChainToJava(chain, 'this')
          javaBody += `    ${javaChain}\n`
        } else {
          node.forEachChild(visit)
        }
      }
      body.forEach(visit)

      methods.push(`${methodSignature}
${javaBody}
    return this;
}`)
    }
  })

  return methods
}

// main
const mode = process.argv[2]
const inputPath = process.argv[3]
if (!inputPath) {
  console.error(
    '❌ inputPath is missing\nusage: node index.js <mode> <your.cy.ts>'
  )
  process.exit(1)
}

const input = fs.readFileSync(inputPath, 'utf-8')
const sourceFile = ts.createSourceFile(
  path.basename(inputPath),
  input,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
)

switch (mode) {
  case 'convert': {
    /** @type {ts.CallExpression[]} */
    const describeCalls = []
    /**
     * @param {ts.Node} node
     */
    function collectDescribeCalls(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.getText() === 'describe'
      ) {
        describeCalls.push(node)
      }
      ts.forEachChild(node, collectDescribeCalls)
    }
    collectDescribeCalls(sourceFile)

    for (const describeCall of describeCalls) {
      const result = convertDescribeBlock(describeCall)
      if (result) {
        const outPath = path.join(OUTPUT_DIR, `${result.className}.java`)
        fs.writeFileSync(outPath, result.javaCode, 'utf-8')
        console.log(`✅ output: ${outPath}`)
      }
    }
    break
  }
  case 'collect': {
    const code = fs.readFileSync(inputPath, 'utf8')
    const methods = convertCypressCommandsToJava(inputPath, code)

    const javaClass = `package ${PACKAGE_NAME};

import org.junit.Assert;
import org.openqa.selenium.*;
import org.openqa.selenium.chrome.ChromeDriver;
import java.net.*;
import java.io.*;

public class ${ORIGINAL_DRIVER_CLASS_NAME} extends ChromeDriver {
${methods.join('\n\n')}
}
`.trim()

    const outPath = path.join(OUTPUT_DIR, `${ORIGINAL_DRIVER_CLASS_NAME}.java`)
    fs.writeFileSync(outPath, javaClass, 'utf8')
    fs.writeFileSync(
      ORIGINAL_COMMAND_LIST_FILE,
      ORIGINAL_COMMAND_LIST.join('\n'),
      'utf8'
    )
    console.log(`✅ output: ${outPath}`)
    console.log(`✅ command list output: ${ORIGINAL_COMMAND_LIST_FILE}`)
    break
  }
  default: {
    console.error(
      '❌ invalid mode. use "convert" or "collect"\nusage: node index.js <mode> <your.cy.ts>'
    )
    process.exit(1)
  }
}
