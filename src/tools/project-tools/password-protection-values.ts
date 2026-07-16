import { randomInt } from 'node:crypto';

const PASSWORD_FRUITS = [
  'banana',
  'cherry',
  'orange',
  'papaya',
  'apricot',
  'coconut',
  'avocado',
  'pumpkin',
  'tangerine',
  'blueberry',
  'pineapple',
  'nectarine',
  'grapefruit',
] as const;

export const generateSitePassword = (): string => {
  const fruit = PASSWORD_FRUITS[randomInt(PASSWORD_FRUITS.length)];
  return `${fruit}${randomInt(100, 1000)}`;
};

export const isPasswordProtected = (site: any): boolean =>
  site?.has_password === true && site?.password_context === 'all';

export const assertPasswordProtectionVerified = (site: any): void => {
  if (!isPasswordProtected(site)) {
    throw new Error('Netlify password protection could not be verified. Deployment was stopped before any files were uploaded.');
  }
};
