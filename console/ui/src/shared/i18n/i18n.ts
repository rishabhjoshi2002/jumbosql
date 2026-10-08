import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import shared from './locales/en/shared.json';
import operations from './locales/en/operations.json';
import settings from './locales/en/settings.json';
import clusters from './locales/en/clusters.json';
import validation from './locales/en/validation.json';
import toasts from './locales/en/toasts.json';
import insights from './locales/en/insights.json';
import discover from './locales/en/discover.json';
import { LOCALES } from '../config/constants';

import LanguageDetector from 'i18next-browser-languagedetector';

const resources = {
  en: {
    shared,
    clusters,
    operations,
    settings,
    validation,
    toasts,
    insights,
    discover,
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    ns: ['shared', 'clusters', 'operations', 'settings', 'validation', 'toasts', 'insights', 'discover'],
    fallbackLng: LOCALES.EN_US,
    supportedLngs: Object.values(LOCALES),
    returnNull: false,
    // React escapes everything it renders; escaping here too shows "&#x2F;" for every "/"
    interpolation: { escapeValue: false },
    debug: false,
  });

export default i18n;
