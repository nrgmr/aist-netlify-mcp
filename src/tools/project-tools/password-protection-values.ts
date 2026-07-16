import { randomInt } from 'node:crypto';

const LOWERCASE_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

export const generateSitePassword = (): string => {
  const letters = Array.from(
    { length: 5 },
    () => LOWERCASE_LETTERS[randomInt(LOWERCASE_LETTERS.length)],
  ).join('');
  const numbers = randomInt(100).toString().padStart(2, '0');
  return `${letters}${numbers}`;
};

export const isPasswordProtected = (site: any): boolean =>
  site?.has_password === true && site?.password_context === 'all';

export const assertPasswordProtectionVerified = (site: any): void => {
  if (!isPasswordProtected(site)) {
    throw new Error('Netlify password protection could not be verified. Deployment was stopped before any files were uploaded.');
  }
};
