# I18N Audit — VoiceToClipboard

Automated audit of translation-key usage vs `locales/{en,es,zh}.json` (all 3 files hold
identical key sets — 238 keys after flattening — with no missing/empty/untranslated values).

## Status: RESOLVED (release polish pass)

The issues below were found in the original audit and are now fixed:

| # | Severity | Issue | Fix |
| :--- | :--- | :--- | :--- |
| 1 | HIGH | Model card name/description/license were raw English | `renderModelCard()` now resolves `model.<key>.name`, `model.<key>.desc`, and the new `model.licensePrefix` key. |
| 2 | HIGH | `models.qualityNote` destroyed by `applyI18n()` re-rendering `#model-reco-note` | `applyI18n()` now re-appends the translated quality note after `models.note`. |
| 3 | HIGH | `'✓ MODEL READY'` never translated | `tr()` now special-cases it to `status.MODEL_READY`. |
| 4 | MEDIUM | Status badge compared against raw-English strings | `checkApiKeyStatus()` compares against `tr()`-localized strings. |
| 5 | MEDIUM | History list raw engine/chars + not re-localized on language switch | Engine badge uses `engine.gemini`/`engine.offline`; char count uses `history.chars`; `setUiLanguage()` re-renders the list. |
| 6 | MEDIUM | Mic `<select>` rebuilt without i18n + not refreshed on language switch | Fallbacks use `mic.unnamed`/`mic.disconnected`; `setUiLanguage()` re-populates devices; the raw label is stored in a `data-raw-label` attribute. |
| 7 | MEDIUM | Model dropdown collapsed label raw English | `updateDropdownCurrent()` resolves `models.tier.<tier>`. |
| 8 | LOW | Remaining raw strings (lang names, mic fallbacks, `License: ` prefix) | Lang names resolve `lang.<code>`; license prefix uses `model.licensePrefix`. |
| 9 | LOW | Window title + close-button labels raw English | `document.title` resolves `app.name`; close button uses `data-i18n-title="settings.close"`. |
| — | LOW | API-key note (`Key set via…`, `No key yet…`, `✓ Key saved…`) raw English | New keys `gemini.envKeyTitle`, `gemini.envKeyNote`, `gemini.keySaved`, `gemini.noKey`. |
| — | LOW | Download error hints (`friendlyDownloadError`) raw English | New keys `model.errorArchive/Timeout/Network/Server/Incomplete`. |

## Noted but intentionally left

- **Dead locale keys** (`welcome.*`, `spacepaste.*`, `settingsWindow.title`, etc.): harmless
  drift, no user-visible impact. Not removed to avoid churn near a release.
- **`data-i18n-hint` tooltip infrastructure** is wired but unused in markup; harmless.
