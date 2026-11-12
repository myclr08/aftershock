import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideRunnerMode, mtpFilterStyle, parseGetPropertyOutput, readGlobalJsonRunner, stripJsonComments } from '../../src/core/runnerMode';
import { tempDir, writeFile } from './helpers';

describe('runner mode detection', () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => ({ dir, cleanup } = tempDir()));
  afterEach(() => cleanup());

  it('reads test.runner from the nearest global.json (comments allowed)', () => {
    writeFile(path.join(dir, 'global.json'), '{\n  // SDK\n  "sdk": { "version": "10.0.100" },\n  "test": { "runner": "Microsoft.Testing.Platform" }, /* trailing */\n}');
    const nested = path.join(dir, 'src', 'App');
    writeFile(path.join(nested, 'x.txt'), '');
    expect(readGlobalJsonRunner(nested)).toEqual({ file: path.join(dir, 'global.json'), runner: 'Microsoft.Testing.Platform' });
  });

  it('stops at the first global.json even without a runner', () => {
    writeFile(path.join(dir, 'global.json'), '{ "test": { "runner": "Microsoft.Testing.Platform" } }');
    writeFile(path.join(dir, 'inner', 'global.json'), '{ "sdk": { "version": "8.0.100" } }');
    expect(readGlobalJsonRunner(path.join(dir, 'inner')).runner).toBeUndefined();
  });

  it('keeps comment markers inside strings', () => {
    expect(JSON.parse(stripJsonComments('{"a": "http://x/*y*/", "b": 1, }'))).toEqual({ a: 'http://x/*y*/', b: 1 });
  });

  it('decides MTP from global.json regardless of project properties', () => {
    expect(decideRunnerMode({ file: 'global.json', runner: 'Microsoft.Testing.Platform' }, undefined).mode).toBe('mtp');
  });

  it('decides the bridge for an MTP app with TestingPlatformDotnetTestSupport', () => {
    expect(decideRunnerMode({}, { IsTestingPlatformApplication: 'true', TestingPlatformDotnetTestSupport: 'true' }).mode).toBe('bridge');
  });

  it('stays on VSTest otherwise (also for MTP-capable apps without dotnet test support)', () => {
    expect(decideRunnerMode({}, { IsTestingPlatformApplication: 'true', TestingPlatformDotnetTestSupport: 'False' }).mode).toBe('vstest');
    expect(decideRunnerMode({}, { OutputType: 'Exe' }).mode).toBe('vstest');
    expect(decideRunnerMode({}, undefined).mode).toBe('vstest');
  });

  it('parses dotnet msbuild -getProperty output (sample: xUnit v3 in bridge mode)', () => {
    const output = '{\n  "Properties": {\n    "TestingPlatformDotnetTestSupport": "true",\n    "UseMicrosoftTestingPlatformRunner": "true",\n    "IsTestingPlatformApplication": "true",\n    "OutputType": "Exe"\n  }\n}\n';
    const properties = parseGetPropertyOutput(output);
    expect(properties.IsTestingPlatformApplication).toBe('true');
    expect(decideRunnerMode({}, properties).mode).toBe('bridge');
    expect(mtpFilterStyle(['xunit'], properties)).toBe('xunit');
    expect(mtpFilterStyle(['mstest'], {})).toBe('vstest');
    expect(mtpFilterStyle(['nunit'], {})).toBe('vstest');
    expect(() => parseGetPropertyOutput('error MSB1009')).toThrow();
  });
});
