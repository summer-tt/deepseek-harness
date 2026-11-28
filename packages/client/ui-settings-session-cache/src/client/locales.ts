/** Copy for the Session history cache card and its two numeric fields. */

const en = {
  title: 'Session history cache',
  description: 'Set how much session history each browser page caches. Local and remote sessions share the page limit. Saving applies to pages that are already open.',
  sessionLimit: 'Per-session limit (MiB)',
  sessionHint: 'Maximum cache size for the history of one session.',
  pageLimit: 'Page total limit (MiB)',
  pageHint: 'Combined cache limit for all local and remote session history on one browser page.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'You have read-only access to these settings.',
  unavailable: 'The cache settings are currently unavailable.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'Could not save the cache limits. Your edits are still here so you can review them and try again.',
  invalidNumber: 'Enter a whole number from 1 to {max} MiB or leave blank to use the default.',
}

/** Keys used by the Plugins list and form views. */
export type SessionCacheLocaleKey = keyof typeof en

type Dictionary = Record<SessionCacheLocaleKey, string>

const zh: Dictionary = {
  title: '会话历史缓存',
  description: '设置每个浏览器页面缓存多少会话历史。本机与远端会话共享页面总额度。保存后，已打开的页面也会更新。',
  sessionLimit: '单会话上限（MiB）',
  sessionHint: '单个会话的历史缓存容量上限。',
  pageLimit: '页面总上限（MiB）',
  pageHint: '一个浏览器页面内所有本机与远端会话的历史缓存总上限。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '你只有这些设置的读取权限',
  unavailable: '暂时无法加载缓存设置',
  save: '保存',
  saving: '保存中…',
  saveFailed: '无法保存缓存上限。已保留你的修改，请检查后重试',
  invalidNumber: '请输入 1 到 {max} MiB 之间的整数，或留空以使用默认值',
}

const de: Dictionary = {
  title: 'Cache für Sitzungsverläufe',
  description: 'Legen Sie fest, wie viel Sitzungsverlauf jede Browserseite zwischenspeichert. Lokale und entfernte Sitzungen teilen sich das Seitenlimit. Beim Speichern werden bereits geöffnete Seiten aktualisiert.',
  sessionLimit: 'Limit pro Sitzung (MiB)',
  sessionHint: 'Maximale Cache-Größe für den Verlauf einer Sitzung.',
  pageLimit: 'Gesamtlimit der Seite (MiB)',
  pageHint: 'Gemeinsames Cache-Limit für alle lokalen und entfernten Sitzungsverläufe auf einer Browserseite.',
  overridden: 'Überschrieben',
  reset: 'Auf Standard zurücksetzen',
  readOnly: 'Sie haben nur Lesezugriff auf diese Einstellungen.',
  unavailable: 'Die Cache-Einstellungen sind derzeit nicht verfügbar.',
  save: 'Speichern',
  saving: 'Speichern…',
  saveFailed: 'Die Cache-Limits konnten nicht gespeichert werden. Prüfen Sie Ihre Änderungen und versuchen Sie es erneut.',
  invalidNumber: 'Geben Sie eine ganze Zahl von 1 bis {max} MiB ein oder lassen Sie das Feld für den Standardwert leer.',
}

const es: Dictionary = {
  title: 'Caché del historial de sesiones',
  description: 'Elige cuánto historial de sesiones guarda en caché cada página del navegador. Las sesiones locales y remotas comparten el límite de la página. Al guardar, se actualizan las páginas que ya están abiertas.',
  sessionLimit: 'Límite por sesión (MiB)',
  sessionHint: 'Tamaño máximo de la caché del historial de una sesión.',
  pageLimit: 'Límite total de la página (MiB)',
  pageHint: 'Límite de caché para el historial de todas las sesiones locales y remotas de una página del navegador.',
  overridden: 'Personalizado',
  reset: 'Restablecer valor predeterminado',
  readOnly: 'Solo tienes permiso para consultar estos ajustes.',
  unavailable: 'Los ajustes de la caché no están disponibles en este momento.',
  save: 'Guardar',
  saving: 'Guardando…',
  saveFailed: 'No se pudieron guardar los límites de la caché. Revisa los cambios y vuelve a intentarlo.',
  invalidNumber: 'Introduce un número entero entre 1 y {max} MiB o deja el campo vacío para usar el valor predeterminado.',
}

const fr: Dictionary = {
  title: 'Cache de l’historique des sessions',
  description: 'Définissez la quantité d’historique mise en cache par chaque page du navigateur. Les sessions locales et distantes partagent la limite de la page. L’enregistrement s’applique aussi aux pages déjà ouvertes.',
  sessionLimit: 'Limite par session (MiB)',
  sessionHint: 'Taille maximale du cache de l’historique d’une session.',
  pageLimit: 'Limite totale par page (MiB)',
  pageHint: 'Limite de cache pour l’ensemble des historiques de sessions locales et distantes sur une page du navigateur.',
  overridden: 'Personnalisé',
  reset: 'Rétablir la valeur par défaut',
  readOnly: 'Vous avez uniquement un accès en lecture à ces paramètres.',
  unavailable: 'Les paramètres du cache sont actuellement indisponibles.',
  save: 'Enregistrer',
  saving: 'Enregistrement…',
  saveFailed: 'Impossible d’enregistrer les limites du cache. Vérifiez vos modifications, puis réessayez.',
  invalidNumber: 'Saisissez un entier de 1 à {max} MiB ou laissez le champ vide pour utiliser la valeur par défaut.',
}

const ja: Dictionary = {
  title: 'セッション履歴キャッシュ',
  description: 'ブラウザーのページごとにキャッシュするセッション履歴の容量を設定します。ローカルとリモートのセッションはページの上限を共有します。保存すると、すでに開いているページにも反映されます。',
  sessionLimit: 'セッションごとの上限（MiB）',
  sessionHint: '1 つのセッションの履歴に使える最大キャッシュ容量です。',
  pageLimit: 'ページ全体の上限（MiB）',
  pageHint: '1 ページでローカルとリモートの全セッション履歴に使えるキャッシュの合計上限です。',
  overridden: '変更済み',
  reset: '既定値に戻す',
  readOnly: 'この設定は読み取り専用です。',
  unavailable: 'キャッシュ設定は現在利用できません。',
  save: '保存',
  saving: '保存中…',
  saveFailed: 'キャッシュの上限を保存できませんでした。変更内容を確認して、もう一度お試しください。',
  invalidNumber: '1 から {max} MiB までの整数を入力してください。空欄にすると既定値を使用します。',
}

const pt: Dictionary = {
  title: 'Cache do histórico de sessões',
  description: 'Defina quanto histórico de sessões cada página do navegador guarda em cache. As sessões locais e remotas compartilham o limite da página. Ao salvar, as páginas já abertas também são atualizadas.',
  sessionLimit: 'Limite por sessão (MiB)',
  sessionHint: 'Tamanho máximo do cache do histórico de uma sessão.',
  pageLimit: 'Limite total da página (MiB)',
  pageHint: 'Limite de cache para o histórico de todas as sessões locais e remotas em uma página do navegador.',
  overridden: 'Personalizado',
  reset: 'Restaurar padrão',
  readOnly: 'Você só tem permissão de leitura para estas configurações.',
  unavailable: 'As configurações de cache estão indisponíveis no momento.',
  save: 'Salvar',
  saving: 'Salvando…',
  saveFailed: 'Não foi possível salvar os limites do cache. Confira suas alterações e tente novamente.',
  invalidNumber: 'Insira um número inteiro de 1 a {max} MiB ou deixe o campo vazio para usar o valor padrão.',
}

const ru: Dictionary = {
  title: 'Кэш истории сеансов',
  description: 'Укажите, сколько истории сеансов хранится в кэше каждой страницы браузера. Локальные и удалённые сеансы используют общий лимит страницы. Сохранённые настройки применяются и к уже открытым страницам.',
  sessionLimit: 'Лимит на сеанс (MiB)',
  sessionHint: 'Максимальный размер кэша истории одного сеанса.',
  pageLimit: 'Общий лимит страницы (MiB)',
  pageHint: 'Общий лимит кэша истории локальных и удалённых сеансов на одной странице браузера.',
  overridden: 'Переопределено',
  reset: 'Восстановить значение по умолчанию',
  readOnly: 'Эти настройки доступны только для чтения.',
  unavailable: 'Настройки кэша сейчас недоступны.',
  save: 'Сохранить',
  saving: 'Сохранение…',
  saveFailed: 'Не удалось сохранить лимиты кэша. Проверьте изменения и повторите попытку.',
  invalidNumber: 'Введите целое число от 1 до {max} MiB или оставьте поле пустым для значения по умолчанию.',
}

/** Settings copy in every shipped Client locale. */
export const dictionaries = { en, zh, de, es, fr, ja, pt, ru }
