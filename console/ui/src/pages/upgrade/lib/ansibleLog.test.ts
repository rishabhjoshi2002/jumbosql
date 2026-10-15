import { describe, expect, it } from 'vitest';
import { parseAnsibleLog, stripAnsi } from './ansibleLog.ts';

const log = `PLAY [Upgrade PgBouncer] *****

TASK [Installed version] *****
ok: [10.0.0.31]
ok: [10.0.0.32]

TASK [Install the new version] *****
changed: [10.0.0.31]
fatal: [10.0.0.32]: FAILED! => {"changed": false, "msg": "non-zero return code", "stderr": "E: Version not found"}

TASK [Optional] *****
fatal: [10.0.0.31]: FAILED! => {"msg": "nope"}
...ignoring
`;

describe('parseAnsibleLog', () => {
  it('follows each host while it runs', () => {
    const p = parseAnsibleLog(log, ['10.0.0.33']);
    expect(p.order).toEqual(['10.0.0.33', '10.0.0.31', '10.0.0.32']);
    expect(p.task).toBe('Optional');
    expect(p.hosts['10.0.0.31'].state).toBe('working');
    expect(p.hosts['10.0.0.31'].changed).toBe(1);
    expect(p.hosts['10.0.0.32'].state).toBe('failed');
    expect(p.hosts['10.0.0.32'].error).toContain('Version not found');
    expect(p.hosts['10.0.0.33'].state).toBe('waiting');
    expect(p.finished).toBe(false);
  });

  it('takes the final state from the recap', () => {
    const p = parseAnsibleLog(
      `${log}\nPLAY RECAP *****\n10.0.0.31 : ok=3 changed=1 unreachable=0 failed=0 skipped=0 rescued=0 ignored=1\n` +
        `10.0.0.32 : ok=1 changed=0 unreachable=0 failed=1 skipped=0 rescued=0 ignored=0\n`,
    );
    expect(p.finished).toBe(true);
    expect(p.hosts['10.0.0.31'].state).toBe('changed');
    expect(p.hosts['10.0.0.32'].state).toBe('failed');
    expect(p.hosts['10.0.0.32'].recap?.failed).toBe(1);
  });
});

describe('coloured output', () => {
  it('reads a log with terminal colour codes', () => {
    const c = '\u001b[0;32mok: [10.0.0.31]\u001b[0m\r\nPLAY RECAP ***\n\u001b[0;31m10.0.0.31\u001b[0m : \u001b[0;32mok=3\u001b[0m changed=0    unreachable=0    \u001b[0;31mfailed=1\u001b[0m skipped=0\n';
    const p = parseAnsibleLog('TASK [Back up] ***\n' + c);
    expect(p.hosts['10.0.0.31'].state).toBe('failed');
    expect(stripAnsi('\u001b[0;32mok\u001b[0m')).toBe('ok');
  });
});
