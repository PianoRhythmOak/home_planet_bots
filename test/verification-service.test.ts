import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { isStaff, panelComponents, staffControls } from '../src/features/verification/service.js';

describe('verification helpers', () => {
  it('recognizes managers and configured staff roles', () => {
    const member = (manageGuild: boolean, roleIds: string[]) =>
      ({
        permissions: { has: (permission: bigint) => manageGuild && permission === PermissionFlagsBits.ManageGuild },
        roles: { cache: { has: (id: string) => roleIds.includes(id) } },
      }) as never;

    assert.equal(isStaff(member(true, []), []), true);
    assert.equal(isStaff(member(false, ['staff']), ['staff']), true);
    assert.equal(isStaff(member(false, ['other']), ['staff']), false);
  });

  it('builds the public panel button with the configured label', () => {
    const button = panelComponents('Let me in').toJSON().components[0];
    assert.ok(button && 'custom_id' in button);
    assert.equal(button.custom_id, 'verify:start');
    assert.equal(button.label, 'Let me in');
  });

  it('can disable every staff control after a decision', () => {
    const controls = staffControls(true).toJSON().components;
    assert.equal(controls.length, 3);
    assert.ok(controls.every((control) => control.disabled));
    assert.deepEqual(
      controls.map((control) => ('custom_id' in control ? control.custom_id : null)),
      ['verify:approve', 'verify:deny', 'verify:close'],
    );
  });
});
