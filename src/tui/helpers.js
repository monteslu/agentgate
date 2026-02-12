import termkit from 'terminal-kit';

const term = termkit.terminal;

export { term };

export async function selectPrompt(message, choices) {
  term('\n  ').bold(message)('\n\n');
  const items = choices.map(c => c.message || c.name);
  const result = await term.singleColumnMenu(items, {
    selectedStyle: term.bgCyan.black,
    leftPadding: '    ',
    selectedLeftPadding: '  ▸ ',
    submittedLeftPadding: '  ▸ '
  }).promise;
  term('\n');
  return choices[result.selectedIndex].name;
}

export async function inputPrompt(message, opts = {}) {
  term('  ').bold(message)(': ');
  const result = await term.inputField({
    default: opts.initial || '',
    cancelable: true
  }).promise;
  term('\n');
  if (result === null || result === undefined) {
    throw { code: 'CANCELLED' };
  }
  if (opts.validate) {
    const valid = opts.validate(result);
    if (valid !== true) {
      term.red(`  ${valid}\n`);
      throw { code: 'CANCELLED' };
    }
  }
  return result;
}

export async function passwordPrompt(message) {
  term('  ').bold(message)(': ');
  const result = await term.inputField({
    echoChar: '*',
    cancelable: true
  }).promise;
  term('\n');
  if (result === null || result === undefined) {
    throw { code: 'CANCELLED' };
  }
  return result;
}

export async function confirmPrompt(message) {
  term('  ').bold(message)(' [y/n] ');
  const result = await term.yesOrNo({ yes: ['y', 'Y', 'ENTER'], no: ['n', 'N'] }).promise;
  term('\n');
  return result;
}

export async function asyncAction(message, fn) {
  const spinner = await term.spinner('dotSpinner');
  term(` ${message}`);
  try {
    const result = await fn();
    spinner.animate(false);
    term.column(1).eraseLine().green('  ✓ ')(message)('\n');
    return result;
  } catch (err) {
    spinner.animate(false);
    term.column(1).eraseLine().red('  ✗ ')(err.message || 'Operation failed')('\n');
    throw err;
  }
}

export function handleCancel(err) {
  if (err === '' || err?.message === '' || err?.code === 'ERR_USE_AFTER_CLOSE' || err?.code === 'CANCELLED') {
    return true;
  }
  return false;
}
