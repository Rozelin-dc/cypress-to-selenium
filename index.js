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

const SPECIAL_KEY_MAP = Object.freeze({
  '{enter}': 'Keys.ENTER',
  '{backspace}': 'Keys.BACK_SPACE',
  '{esc}': 'Keys.ESCAPE',
  '{del}': 'Keys.DELETE',
  '{tab}': 'Keys.TAB',
  '{space}': '" "',
  '{leftarrow}': 'Keys.ARROW_LEFT',
  '{rightarrow}': 'Keys.ARROW_RIGHT',
  '{uparrow}': 'Keys.ARROW_UP',
  '{downarrow}': 'Keys.ARROW_DOWN',
  '{home}': 'Keys.HOME',
  '{end}': 'Keys.END',
  '{pagedown}': 'Keys.PAGE_DOWN',
  '{pageup}': 'Keys.PAGE_UP',
  '{ctrl}': 'Keys.CONTROL',
  '{alt}': 'Keys.ALT',
  '{shift}': 'Keys.SHIFT',
  '{meta}': 'Keys.META',
})

const TAB_SIZE = 4
let indentDepth = 0
/**
 * @return {string}
 */
function getIndent() {
  return ' '.repeat(TAB_SIZE * indentDepth)
}

/**
 * @param {ts.Node} node
 * @return {string}
 */
function escapeJavaString(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return `"${node.text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')}"`
  } else if (ts.isTemplateExpression(node)) {
    /** @type {string[]} */
    const parts = []

    const head = node.head.text
    if (head) {
      parts.push(
        `"${head
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')}"`
      )
    }

    for (const span of node.templateSpans) {
      const expr = span.expression.getText()
      parts.push(expr)

      const tail = span.literal.text
      if (tail) {
        parts.push(
          `"${tail
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')}"`
        )
      }
    }

    return parts.join(' + ')
  } else {
    return node.getText()
  }
}

/**
 * @typedef {{ method: string, args: ReadonlyArray<ts.Expression> }} ChainItem
 */
/**
 * @param {ts.Node} callExpr
 * @return {ChainItem[]}
 */
function extractChain(callExpr) {
  /** @type {ChainItem[]} */
  const chain = []
  let current = callExpr

  while (
    ts.isCallExpression(current) ||
    ts.isPropertyAccessExpression(current)
  ) {
    if (ts.isCallExpression(current)) {
      let method = ''
      let args = current.arguments
      if (ts.isPropertyAccessExpression(current.expression)) {
        method = current.expression.name.escapedText.toString()
        current = current.expression.expression
      } else if (ts.isIdentifier(current.expression)) {
        method = current.expression.escapedText.toString()
        current = current.expression
      }
      chain.unshift({
        method,
        args,
      })
    } else if (ts.isPropertyAccessExpression(current)) {
      const method = current.name.escapedText.toString()
      chain.unshift({
        method,
        args: [],
      })
      current = current.expression
    } else {
      break
    }
  }

  return chain
}

let tempVarIndex = 0
/**
 * @param {ChainItem[]} chain
 * @param {(node: ts.Node) => void} visitFunc
 * @param {string} [driverName]
 * @return {string}
 */
function convertChainToJava(chain, visitFunc, driverName = 'driver') {
  if (chain[0].method === 'expect') {
    return convertExpectChainToJava(chain)
  } else {
    return convertCyChainToJava(chain, visitFunc, driverName)
  }
}
/**
 * @param {ChainItem[]} chain
 * @return {string}
 */
function convertExpectChainToJava(chain) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return ''
  }

  let target = ''
  let matcher = ''
  /** @type {ReadonlyArray<ts.Expression>} */
  let args = []

  for (let i = 0; i < chain.length; i++) {
    const { method, args: currentArgs } = chain[i]

    switch (method) {
      case 'expect': {
        if (currentArgs.length < 1) {
          return '/* expect() without arguments */'
        }
        target = escapeJavaString(currentArgs[0])
        break
      }
      case 'to':
      case 'be':
      case 'and':
      case 'have':
      case 'that':
      case 'with': {
        // no-op for chaining methods
        break
      }
      case 'true': {
        matcher = 'isTrue'
        break
      }
      case 'false': {
        matcher = 'isFalse'
        break
      }
      case 'null':
      case 'undefined': {
        matcher = 'isNull'
        break
      }
      case 'eq':
      case 'equal': {
        matcher = 'equals'
        args = currentArgs
        break
      }
      case 'deep': {
        if (chain[i + 1] && ['equal', 'eq'].includes(chain[i + 1].method)) {
          matcher = 'equals'
          args = chain[i + 1].args
          i++ // skip next
        }
        break
      }
      case 'lessThan':
      case 'greaterThan': {
        if (currentArgs.length < 1) {
          return `/* expect().${method}() without arguments */`
        }

        matcher = 'isTrue'
        target += ` ${method === 'lessThan' ? '<' : '>'} ${escapeJavaString(
          currentArgs[0]
        )}`
        break
      }
      default: {
        return `// Unsupported expect chain: ${chain
          .map((c) => c.method)
          .join('.')}`
      }
    }
  }

  let code = ''
  switch (matcher) {
    case 'isTrue': {
      code = `AssertJUnit.assertTrue(${target});`
      break
    }
    case 'isFalse': {
      code = `AssertJUnit.assertFalse(${target});`
      break
    }
    case 'isNull': {
      code = `AssertJUnit.assertNull(${target});`
      break
    }
    case 'equals': {
      const expected = args[0]?.getText() ?? '/* missing expected */'
      code = `AssertJUnit.assertEquals(${expected}, ${target});`
      break
    }
    default: {
      code = `// Unsupported matcher in expect: ${matcher}`
      break
    }
  }
  return getIndent() + code
}
/**
 * @param {ChainItem[]} chain
 * @param {(node: ts.Node) => void} visitFunc
 * @param {string} [driverName]
 * @return {string}
 */
function convertCyChainToJava(chain, visitFunc, driverName = 'driver') {
  const expr = [`${driverName}`]

  for (let i = 0; i < chain.length; i++) {
    const { method, args } = chain[i]
    switch (method) {
      case 'contains': {
        if (i !== 0 && i === chain.length - 1) {
          // The last contains in the chain is considered an assertion.
          const argText = escapeJavaString(args[0])
          expr[expr.length - 1] = `WebElement element${tempVarIndex} = ${
            expr[expr.length - 1]
          }`
          expr.push(
            `AssertJUnit.assertTrue(element${tempVarIndex}.getText().contains(${argText}))`
          )
          tempVarIndex++
          break
        }
      }
      case 'get':
      case 'find': {
        const argText = escapeJavaString(args[0])
        let selectorExpr = `By.cssSelector(${argText})`
        if (method === 'contains') {
          selectorExpr = `By.xpath("//*[contains(text(), '${argText.replace(
            /^"(.*)"$/g,
            '$1'
          )}')]")`
        }
        expr[expr.length - 1] += `.findElement(${selectorExpr})`
        break
      }
      case 'eq': {
        if (args.length < 1 || !ts.isNumericLiteral(args[0])) {
          expr[expr.length - 1] += `/* unsupported eq syntax(${restorationChain(
            chain[i]
          )}) */`
          break
        }
        expr[expr.length - 1] = expr[expr.length - 1].replace(
          /(.*)findElement/g,
          '$1findElements'
        )
        expr[expr.length - 1] += `.get(${args[0].text})`
        break
      }
      case 'first': {
        expr[expr.length - 1] = expr[expr.length - 1].replace(
          /(.*)findElement/g,
          '$1findElements'
        )
        expr[expr.length - 1] += '.get(0)'
        break
      }
      case 'last': {
        expr[
          expr.length - 1
        ] = `List<WebElement> elements${tempVarIndex} = ${expr[
          expr.length - 1
        ].replace(/(.*)findElement/g, '$1findElements')}`
        expr.push(
          `elements${tempVarIndex}.get(elements${tempVarIndex}.size() - 1)`
        )
        tempVarIndex++
        break
      }
      case 'click': {
        expr[expr.length - 1] += `.click()`
        break
      }
      case 'type': {
        let typeText = escapeJavaString(args[0])
        Object.keys(SPECIAL_KEY_MAP).forEach((key) => {
          typeText = typeText.replaceAll(key, `" + ${SPECIAL_KEY_MAP[key]} + "`)
        })
        expr[expr.length - 1] += `.sendKeys(${typeText})`
        break
      }
      case 'should': {
        if (args.length < 1 || !ts.isStringLiteral(args[0])) {
          expr[
            expr.length - 1
          ] += `/* unsupported should syntax(${restorationChain(chain[i])}) */`
          break
        }
        const condition = args[0].text
        let assertMethod = ''
        let getConditionMethod = ''
        switch (condition) {
          case 'be.visible': {
            assertMethod = 'assertTrue'
            getConditionMethod = 'isDisplayed'
            break
          }
          case 'not.be.visible': {
            assertMethod = 'assertFalse'
            getConditionMethod = 'isDisplayed'
            break
          }
          case 'not.exist': {
            const temp = expr[expr.length - 1]
            expr[expr.length - 1] = 'try {'
            expr.push(' '.repeat(TAB_SIZE) + temp)
            expr.push(
              ' '.repeat(TAB_SIZE) +
                'AssertJUnit.fail("Element should not exist")'
            )
            expr.push('} catch (NoSuchElementException e) {}')
            break
          }
          default: {
            expr[
              expr.length - 1
            ] += `/* unsupported should condition: ${condition}(${restorationChain(
              chain[i]
            )}) */`
            break
          }
        }
        if (assertMethod === '' || getConditionMethod === '') {
          break
        }
        expr[expr.length - 1] = `WebElement element${tempVarIndex} = ${
          expr[expr.length - 1]
        }`
        expr.push(
          `AssertJUnit.${assertMethod}(element${tempVarIndex}.${getConditionMethod}())`
        )
        expr.push(`element${tempVarIndex}`)
        tempVarIndex++
        break
      }
      case 'visit': {
        expr[expr.length - 1] += `.get(${escapeJavaString(args[0])})`
        break
      }
      case 'request': {
        const [options] = args
        if (i === 0) {
          expr.splice(0)
        }
        if (ts.isStringLiteral(options) || ts.isTemplateLiteral(options)) {
          expr.push(
            `HttpURLConnection conn = (HttpURLConnection) new URL(${escapeJavaString(
              options
            )}).openConnection()`
          )
          expr.push('conn.setRequestMethod("GET")')
        } else if (ts.isObjectLiteralExpression(options)) {
          let url = ''
          let method = 'GET'
          /** @type {string[]} */
          let body = []

          options.properties.forEach((p) => {
            if (!ts.isPropertyAssignment(p)) {
              return
            }
            const name = p.name.getText()
            const val = escapeJavaString(p.initializer)
            if (name === 'url') {
              url = val
            } else if (name === 'method') {
              method = val.replace(/['"]/g, '')
            } else if (name === 'body') {
              if (ts.isObjectLiteralExpression(p.initializer)) {
                body.push('JsonObject jsonObject = new JsonObject()')
                /**
                 * @param {ts.ObjectLiteralElementLike} prop
                 * @param {string} parentName
                 */
                function visitProperty(prop, parentName) {
                  if (!ts.isPropertyAssignment(prop)) {
                    return
                  }

                  const key = `"${escapeJavaString(prop.name)
                    .replace(/^"(.*)"$/g, '$1')
                    .replace(/^'(.*)'$/g, '$1')}"`
                  if (ts.isObjectLiteralExpression(prop.initializer)) {
                    const tempVarName = `${key}Inner${tempVarIndex}`
                    tempVarIndex++
                    body.push(`JsonObject ${tempVarName} = new JsonObject()`)
                    prop.initializer.properties.forEach((p) =>
                      visitProperty(p, tempVarName)
                    )
                    body.push(`${parentName}.add(${key}, ${tempVarName})`)
                  } else {
                    const value = escapeJavaString(prop.initializer)
                    body.push(`${parentName}.addProperty(${key}, ${value})`)
                  }
                }
                p.initializer.properties.forEach((p) =>
                  visitProperty(p, 'jsonObject')
                )
                body.push('String inputString = jsonObject.toString()')
              } else {
                body.push(`String inputString = ${val}`)
              }
            }
          })

          expr.push(
            `HttpURLConnection conn = (HttpURLConnection) new URL(${url}).openConnection()`
          )
          expr.push(`conn.setRequestMethod("${method.toUpperCase()}")`)
          if (body.length > 0) {
            expr.push(`conn.setDoOutput(true)`)
            expr.push(...body)
            expr.push('try(OutputStream os = conn.getOutputStream()) {')
            expr.push(
              ' '.repeat(TAB_SIZE) +
                'byte[] input = inputString.getBytes("utf-8")'
            )
            expr.push(' '.repeat(TAB_SIZE) + 'os.write(input, 0, input.length)')
            expr.push('}')
          }
        } else {
          expr.push(
            `/* unsupported request syntax(${restorationChain(chain[i])}) */`
          )
        }
        break
      }
      case 'then': {
        const cb = args[0]
        if (ts.isFunctionLike(cb)) {
          const body = cb.body
          const innerStatements = { value: '' }
          const innerVisitNode = createVisitNode(
            innerStatements,
            driverName,
            visitFunc
          )
          body.forEachChild(innerVisitNode)
          expr.push(innerStatements.value)
        } else {
          expr.push(
            `/* unsupported then syntax(${restorationChain(chain[i])}) */`
          )
        }
        break
      }
      case 'within': {
        const cb = args[0]
        const parentSelector = expr[expr.length - 1]
        const tempVar = `scopeElement${tempVarIndex++}`
        if (ts.isFunctionLike(cb)) {
          const body = cb.body
          const innerStatements = { value: '' }
          const innerVisitNode = createVisitNode(
            innerStatements,
            tempVar,
            visitFunc
          )
          body.forEachChild(innerVisitNode)
          expr[expr.length - 1] = `WebElement ${tempVar} = ${parentSelector}`
          expr.push(innerStatements.value)
          expr.push(tempVar)
        }
        break
      }
      case 'wait': {
        if (args.length < 1) {
          expr[
            expr.length - 1
          ] += `/* unsupported wait syntax(${restorationChain(chain[i])}) */`
          break
        }
        const timeout = escapeJavaString(args[0])
        expr.push(`Thread.sleep(${timeout})`)
        expr.push(driverName)
        break
      }
      default: {
        if (ORIGINAL_COMMAND_LIST.includes(method)) {
          expr[expr.length - 1] +=
            `.${method}(` + args.map((arg) => arg.getText()).join(', ') + `)`
          break
        }
        expr[
          expr.length - 1
        ] += `/* unsupported method: ${method}(${restorationChain(
          chain[i]
        )}) */`
      }
    }
  }

  return expr.join(';\n' + getIndent()) + ';'
}

/**
 * @param {ChainItem} chain
 * @return {string}
 */
function restorationChain(chain) {
  /** @type {string[]} */
  const argsText = []
  for (const arg of chain.args) {
    argsText.push(arg.getText())
  }
  return `.${chain.method}(${argsText.join(', ')})`
}

/**
 * @param {{value: string}} output
 * @param {string} driverName
 * @param {(node: ts.Node) => void} [visitFunc]
 * @return {(node: ts.Node) => void}
 */
function createVisitNode(output, driverName, visitFunc) {
  /**
   * @return {(node: ts.Node) => void}
   */
  function getVisitFunc() {
    return visitFunc ?? visitNode
  }
  /**
   * @param {ts.Node} node
   * @return {void}
   */
  function visitNode(node) {
    if (ts.isCallExpression(node)) {
      const chain = extractChain(node)
      const javaChain = convertChainToJava(chain, getVisitFunc(), driverName)
      output.value += getIndent() + `${javaChain}\n`
    } else if (ts.isIfStatement(node)) {
      const condition = node.expression.getText()
      output.value += getIndent() + `if (${condition}) {\n`
      indentDepth++
      getVisitFunc()(node.thenStatement)
      indentDepth--
      output.value += getIndent() + '}\n'
      if (node.elseStatement) {
        output.value += getIndent() + 'else {\n'
        indentDepth++
        getVisitFunc()(node.elseStatement)
        indentDepth--
        output.value += getIndent() + '}\n'
      }
      return
    } else if (ts.isForStatement(node)) {
      const initializer = node.initializer?.getText() ?? ''
      const condition = node.condition?.getText() ?? ''
      const incrementor = node.incrementor?.getText() ?? ''
      output.value +=
        getIndent() + `for (${initializer}; ${condition}; ${incrementor}) {\n`
      indentDepth++
      getVisitFunc()(node.statement)
      indentDepth--
      output.value += getIndent() + '}\n'
      return
    } else if (ts.isWhileStatement(node)) {
      const condition = node.expression.getText()
      output.value += getIndent() + `while (${condition}) {\n`
      indentDepth++
      getVisitFunc()(node.statement)
      indentDepth--
      output.value += getIndent() + '}\n'
      return
    } else {
      node.forEachChild(getVisitFunc())
    }
  }

  return visitNode
}

/**
 * @param {ts.CallExpression} describeCall
 * @return {{ className: string, javaCode: string }|null}
 */
function convertDescribeBlock(describeCall) {
  const [descArg, bodyFn] = describeCall.arguments
  if (!ts.isStringLiteral(descArg) || !ts.isFunctionLike(bodyFn)) {
    return null
  }

  const className = descArg.text.replace(/\s+/g, '') + 'Test'
  const output = {
    value: `package ${PACKAGE_NAME};

import org.junit.*;
import org.openqa.selenium.*;
import org.openqa.selenium.chrome.ChromeOptions;
import org.testng.AssertJUnit;
import org.testng.annotations.*;
import com.google.gson.JsonObject;

`,
  }
  output.value += `public class ${className} {\n`
  indentDepth++
  output.value += getIndent() + `${ORIGINAL_DRIVER_CLASS_NAME} driver;\n\n`

  const BeforeOrAfter = {
    beforeEach: { annotation: '@BeforeMethod', method: 'setup', exists: false },
    afterEach: { annotation: '@AfterMethod', method: 'end', exists: false },
    before: { annotation: '@BeforeClass', method: 'setupClass', exists: false },
  }

  const baseVisitNode = createVisitNode(output, 'driver', visit)
  /**
   * @param {ts.Node} node
   * @return {void}
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
          output.value += getIndent() + `${annotation}\n`
          output.value +=
            getIndent() + `public void ${methodName}() throws Exception {\n`
          indentDepth++
          if (annotation === '@Before') {
            output.value +=
              getIndent() +
              'ChromeOptions options = new ChromeOptions().addArguments("--headless");\n'
            output.value +=
              getIndent() +
              `driver = new ${ORIGINAL_DRIVER_CLASS_NAME}(options);\n`
          } else if (annotation === '@After') {
            output.value += getIndent() + 'driver.quit();\n'
          }
          ts.forEachChild(cb.body, visit)
          indentDepth--
          output.value += getIndent() + '}\n\n'
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
            output.value += getIndent() + '@Ignore\n'
          }
          output.value += getIndent() + '@Test\n'
          output.value +=
            getIndent() + `public void ${methodName}() throws Exception {\n`
          indentDepth++
          ts.forEachChild(cb.body, visit)
          indentDepth--
          output.value += getIndent() + '}\n\n'
        }
        return
      }
    }

    baseVisitNode(node)
  }

  ts.forEachChild(bodyFn.body, visit)

  // add @Before / @After if not exists
  if (!BeforeOrAfter.beforeEach.exists) {
    output.value += getIndent() + '@Before\n'
    output.value += getIndent() + 'public void setup() {\n'
    indentDepth++
    output.value +=
      getIndent() +
      'ChromeOptions options = new ChromeOptions().addArguments("--headless");\n'
    output.value +=
      getIndent() + `driver = new ${ORIGINAL_DRIVER_CLASS_NAME}(options);\n`
    indentDepth--
    output.value += getIndent() + '}\n\n'
  }
  if (!BeforeOrAfter.afterEach.exists) {
    output.value += getIndent() + '@AfterMethod\n'
    output.value += getIndent() + 'public void end() {\n'
    indentDepth++
    output.value += getIndent() + 'driver.quit();\n'
    indentDepth--
    output.value += getIndent() + '}\n\n'
  }

  indentDepth--
  output.value += '}\n'

  return { className, javaCode: output.value }
}

/**
 * @param {string} tsFileName
 * @param {string} tsCode
 * @return {string[]}
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
      const methodSignature =
        getIndent() +
        `public ${ORIGINAL_DRIVER_CLASS_NAME} ${commandName}(${args
          .map((a) => `String ${a}`)
          .join(', ')}) throws Exception {`

      /** @type {ReadonlyArray<ts.Node>} */
      let body = []
      if (ts.isBlock(func.body)) {
        body = func.body.statements
      } else {
        body = [func.body]
      }
      const javaBody = { value: '' }
      indentDepth++
      const baseVisitNode = createVisitNode(javaBody, 'this')
      body.forEach(baseVisitNode)

      let method = methodSignature
      method += '\n'
      method += javaBody.value
      method += '\n'
      method += getIndent() + 'return this;\n'
      indentDepth--
      method += getIndent() + '}\n'
      methods.push(method)
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
    indentDepth = 1
    const methods = convertCypressCommandsToJava(inputPath, code)

    const javaClass = `package ${PACKAGE_NAME};

import org.testng.AssertJUnit;
import org.openqa.selenium.*;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import com.google.gson.JsonObject;
import java.net.*;
import java.io.*;

public class ${ORIGINAL_DRIVER_CLASS_NAME} extends ChromeDriver {
    public ${ORIGINAL_DRIVER_CLASS_NAME}(ChromeOptions options) {
        super(options);
    }

${methods.join('\n\n')}
}
`

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
