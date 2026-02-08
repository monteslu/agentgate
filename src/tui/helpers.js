import enquirer from 'enquirer';
import ora from 'ora';

const { Select, Input, Password, Confirm } = enquirer;

export async function selectPrompt(message, choices) {
  const prompt = new Select({
    name: 'value',
    message,
    choices
  });
  return prompt.run();
}

export async function inputPrompt(message, opts = {}) {
  const prompt = new Input({
    name: 'value',
    message,
    initial: opts.initial || undefined,
    validate: opts.validate || undefined
  });
  return prompt.run();
}

export async function passwordPrompt(message) {
  const prompt = new Password({
    name: 'value',
    message
  });
  return prompt.run();
}

export async function confirmPrompt(message) {
  const prompt = new Confirm({
    name: 'value',
    message
  });
  return prompt.run();
}

export async function asyncAction(message, fn) {
  const spinner = ora(message).start();
  try {
    const result = await fn();
    spinner.succeed();
    return result;
  } catch (err) {
    spinner.fail(err.message || 'Operation failed');
    throw err;
  }
}

export function handleCancel(err) {
  if (err === '' || err?.message === '' || err?.code === 'ERR_USE_AFTER_CLOSE') {
    return true;
  }
  return false;
}
