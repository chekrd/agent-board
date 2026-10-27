export const tildeIn = (text: string, home: string) =>
  home ? text.replace(new RegExp(`(?<![\\w./-])${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'g'), '~') : text;
