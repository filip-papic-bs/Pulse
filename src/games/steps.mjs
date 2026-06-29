async function clickInFrames(page, selector, timeout = 6_000) {
  const deadline = Date.now() + timeout;
  while (true) {
    for (const frame of page.frames()) {
      const button = frame.locator(selector).first();
      if ((await button.count()) === 0) continue;
      if (await button.isDisabled().catch(() => false)) continue;
      try {
        await button.click({ timeout: 5_000, force: true });
        return true;
      } catch {
        return false;
      }
    }
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(250);
  }
}

async function isEnabledInFrames(page, selector) {
  for (const frame of page.frames()) {
    const el = frame.locator(selector).first();
    if ((await el.count()) === 0) continue;
    return !(await el.isDisabled().catch(() => true));
  }
  return false;
}

export const click = (selector) => ({
  label: `click ${selector}`,
  run: (page) => clickInFrames(page, selector),
});

export const wait = (ms) => ({
  label: `wait ${ms}ms`,
  run: async (page) => {
    await page.waitForTimeout(ms);
    return true;
  },
});

export const clickUntilEnabled = (trigger, target, tries = 12) => ({
  label: `click ${trigger} until ${target} is enabled`,
  run: async (page) => {
    for (let i = 0; i < tries; i += 1) {
      if (await isEnabledInFrames(page, target)) return true;
      await clickInFrames(page, trigger);
      await page.waitForTimeout(1_000);
    }
    return isEnabledInFrames(page, target);
  },
});

export async function runSteps(steps, page) {
  for (const step of steps) {
    if (!(await step.run(page))) {
      return { ok: false, failed: step.label };
    }
  }
  return { ok: true, failed: null };
}
