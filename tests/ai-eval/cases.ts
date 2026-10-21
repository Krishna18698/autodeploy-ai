// More AI cases for the evaluation (not the corpus, whose figures the site
// quotes). Each build runs real Node, so the model sees the exact errors real
// projects produce.
import { type Case, nodeBuild, writeDist } from '../corpus/generate';

export const EXTRA_AI_CASES: Case[] = [
  {
    name: 'ai-missing-export',
    expect: 'ai',
    note: 'imports a name the module no longer exports (it was renamed)',
    files: {
      ...nodeBuild(`await import('./src/page.mjs');\n${writeDist()}`),
      'src/page.mjs':
        "import { formatDate } from './dates.mjs';\nexport const today = formatDate(new Date(0));\n",
      'src/dates.mjs': 'export const formatDay = (d) => d.toISOString().slice(0, 10);\n',
    },
  },
  {
    name: 'ai-undefined-variable',
    expect: 'ai',
    note: 'a typo in a variable name, thrown while the build renders',
    files: {
      ...nodeBuild(`await import('./src/title.mjs');\n${writeDist()}`),
      'src/title.mjs': "const title = 'Docs';\nexport const heading = titel.toUpperCase();\n",
    },
  },
  {
    name: 'ai-json-trailing-comma',
    expect: 'ai',
    note: 'a trailing comma in a JSON file the build reads',
    files: {
      ...nodeBuild(
        `import { readFileSync } from 'node:fs';\nconst nav = JSON.parse(readFileSync('src/nav.json', 'utf8'));\nif (!nav.links.length) process.exit(1);\n${writeDist()}`,
      ),
      'src/nav.json': '{\n  "links": [\n    "home",\n    "about",\n  ]\n}\n',
    },
  },
  {
    name: 'ai-await-outside-async',
    expect: 'ai',
    note: 'await inside a function that is not async',
    files: {
      ...nodeBuild(
        `const { load } = await import('./src/load.mjs');\nawait load();\n${writeDist()}`,
      ),
      'src/load.mjs':
        'export function load() {\n  const data = await Promise.resolve([1, 2]);\n  return data;\n}\n',
    },
  },
  {
    name: 'ai-upstream-api-down',
    expect: 'escalated',
    note: 'the build fetches from an API that is down: code changes would only hide it',
    files: {
      ...nodeBuild(`await import('./src/posts.mjs');\n${writeDist()}`),
      'src/posts.mjs':
        "const res = await fetch('http://127.0.0.1:9/posts.json');\nexport const posts = await res.json();\n",
    },
  },
];
