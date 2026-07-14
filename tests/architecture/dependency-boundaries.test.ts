import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packagesRoot = path.join(root, 'packages');
const appsRoot = path.join(root, 'apps');

describe('architecture dependency boundaries', () => {
  it('keeps adapters below workflows and business steps', () => {
    const violations = sourceFiles(path.join(packagesRoot, 'adapters-1688'))
      .concat(sourceFiles(path.join(packagesRoot, 'adapters-ozon')))
      .flatMap((file) => forbiddenImports(file, [
        '@auto-ozon/step-',
        '@auto-ozon/workflows',
        '@auto-ozon/transformer',
      ]));
    expect(violations).toEqual([]);
  });

  it('keeps contracts implementation-free', () => {
    const violations = sourceFiles(path.join(packagesRoot, 'contracts')).flatMap((file) =>
      importsOf(file)
        .filter((specifier) => !specifier.startsWith('./'))
        .map((specifier) => `${relative(file)} -> ${specifier}`),
    );
    expect(violations).toEqual([]);
  });

  it('prevents steps from importing CLI, workflows, or another step', () => {
    const stepsRoot = path.join(packagesRoot, 'steps');
    const violations = sourceFiles(stepsRoot).flatMap((file) => {
      const ownPackage = path.basename(path.dirname(path.dirname(file)));
      return importsOf(file).flatMap((specifier) => {
        if (specifier.startsWith('@auto-ozon/workflows') || specifier.includes('apps/cli')) {
          return [`${relative(file)} -> ${specifier}`];
        }
        const match = specifier.match(/^@auto-ozon\/step-(.+)$/);
        return match && match[1] !== ownPackage
          ? [`${relative(file)} -> ${specifier}`]
          : [];
      });
    });
    expect(violations).toEqual([]);
  });

  it('uses package exports for every cross-package import', () => {
    const violations = [...sourceFiles(packagesRoot), ...sourceFiles(appsRoot)]
      .flatMap((file) => importsOf(file).flatMap((specifier) => {
        if (!specifier.startsWith('.')) return [];
        const target = path.resolve(path.dirname(file), specifier);
        const sourceOwner = ownerOf(file);
        const targetOwner = ownerOf(target);
        return sourceOwner && targetOwner && sourceOwner !== targetOwner
          ? [`${relative(file)} -> ${specifier}`]
          : [];
      }));
    expect(violations).toEqual([]);
  });

  it('keeps one public run entry per business step', () => {
    const stepPackages = fs.readdirSync(path.join(packagesRoot, 'steps'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const violations: string[] = [];
    for (const step of stepPackages) {
      const packageJson = JSON.parse(fs.readFileSync(
        path.join(packagesRoot, 'steps', step, 'package.json'),
        'utf8',
      )) as { exports?: Record<string, unknown> };
      const index = fs.readFileSync(path.join(packagesRoot, 'steps', step, 'src', 'index.ts'), 'utf8');
      const runEntries = [...new Set(index.match(/\brun[A-Z][A-Za-z0-9_]*/g) ?? [])];
      const expectedCount = ['attribute-mapping', 'draft-generation'].includes(step) ? 2 : 1;
      if (runEntries.length !== expectedCount) violations.push(`${step}: ${runEntries.join(', ') || 'none'}`);
      const expectedExports = step === 'draft-generation' ? ['.', './legacy'] : ['.'];
      if (JSON.stringify(Object.keys(packageJson.exports ?? {})) !== JSON.stringify(expectedExports)) {
        violations.push(`${step}: exports must contain ${expectedExports.join(', ')}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps CLI free of category and attribute business validation', () => {
    const forbidden = [
      'loadOzonCategoryIndex',
      'validateCategoryDecision',
      'validateCategoryDecisionSchema',
      'runCategoryAttributes',
      'runAttributeMapping',
      'saveCategoryDecisionSnapshot',
      'saveCategoryAttributesSnapshot',
    ];
    const violations = sourceFiles(path.join(appsRoot, 'cli')).flatMap((file) =>
      forbidden
        .filter((symbol) => fs.readFileSync(file, 'utf8').includes(symbol))
        .map((symbol) => `${relative(file)} contains ${symbol}`),
    );
    expect(violations).toEqual([]);
  });
});

function sourceFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && file.endsWith('.ts') ? [file] : [];
  });
}

function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)]
    .map((match) => match[2]!);
}

function forbiddenImports(file: string, prefixes: string[]): string[] {
  return importsOf(file)
    .filter((specifier) => prefixes.some((prefix) => specifier.startsWith(prefix)))
    .map((specifier) => `${relative(file)} -> ${specifier}`);
}

function ownerOf(file: string): string | null {
  const normalized = path.normalize(file);
  for (const base of [packagesRoot, appsRoot]) {
    const rel = path.relative(base, normalized);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `${path.basename(base)}/${rel.split(path.sep)[0]}`;
    }
  }
  return null;
}

function relative(file: string): string {
  return path.relative(root, file).replaceAll('\\', '/');
}
