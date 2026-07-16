import { getAPIJSONResult } from '../../utils/api-networking.js';
import {
  assertPasswordProtectionVerified,
  generateSitePassword,
  isPasswordProtected,
} from './password-protection-values.js';

type EnsurePasswordProtectionResult = {
  site: any;
  passwordWasSet: boolean;
  sitePassword?: string;
};

export const ensurePasswordProtection = async ({
  siteId,
  request,
}: {
  siteId: string;
  request?: Request;
}): Promise<EnsurePasswordProtectionResult> => {
  const sitePath = `/api/v1/sites/${siteId}`;
  const currentSite = await getAPIJSONResult(sitePath, {}, {}, request);

  if (isPasswordProtected(currentSite)) {
    return { site: currentSite, passwordWasSet: false };
  }

  const sitePassword = generateSitePassword();

  await getAPIJSONResult(
    sitePath,
    {
      method: 'PUT',
      body: JSON.stringify({
        password: sitePassword,
        password_context: 'all',
        sso_login: false,
        sso_login_context: 'all',
      }),
    },
    {},
    request,
  );

  const verifiedSite = await getAPIJSONResult(sitePath, {}, {}, request);
  assertPasswordProtectionVerified(verifiedSite);

  return {
    site: verifiedSite,
    passwordWasSet: true,
    sitePassword,
  };
};
