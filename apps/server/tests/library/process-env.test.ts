import { describe, expect, it } from 'vitest';
import { splitCommand } from '../../src/contexts/library/infrastructure/notebooklm/process-env';

describe('splitCommand', () => {
  it('splits a plain command on whitespace', () => {
    expect(splitCommand('  notebooklm  ')).toEqual({ cmd: 'notebooklm', args: [] });
    expect(splitCommand('node fixture.mjs --x=1')).toEqual({
      cmd: 'node',
      args: ['fixture.mjs', '--x=1'],
    });
  });

  it('keeps quoted parts with spaces together and backslashes literal', () => {
    expect(splitCommand('"C:\\Program Files\\nodejs\\node.exe" "D:\\a b\\cli.mjs" --v')).toEqual({
      cmd: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['D:\\a b\\cli.mjs', '--v'],
    });
    expect(splitCommand("'/opt/my venv/bin/notebooklm'")).toEqual({
      cmd: '/opt/my venv/bin/notebooklm',
      args: [],
    });
  });

  it('returns an empty command for blank input', () => {
    expect(splitCommand('   ')).toEqual({ cmd: '', args: [] });
  });
});
