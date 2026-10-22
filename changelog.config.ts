// Список изменений GitHub-релиза (группы feat, fix, perf, refactor, docs,
// build, chore, ci): grouped conventional-commit changelog,
// который собирает changelogen в .github/workflows/release.yml (через
// .github/scripts/release-notes.mjs). CHANGELOG.md он не трогает.
//
// changelogen сливает этот объект со своими умолчаниями, а не заменяет их:
// группа, которой здесь нет, осталась бы в выводе. Поэтому лишние типы
// выключены явно (`false`), а коммит без типа или с типом не из списка
// (`Release vX.Y.Z`, `i18n(...)`) в релиз не попадает вовсе.
export default {
  // Ссылки на коммиты и «compare» ведут в тот репозиторий, где идёт сборка:
  // в основном это icecompany-tech/iceslab, на песочнице её собственный, и
  // ссылки там не битые.
  repo: process.env.GITHUB_REPOSITORY || 'icecompany-tech/iceslab',
  types: {
    feat: { title: '🚀 Features' },
    fix: { title: '🩹 Fixes' },
    perf: { title: '🔥 Performance' },
    refactor: { title: '💅 Refactors' },
    docs: { title: '📖 Documentation' },
    chore: { title: '🏡 Chore' },
    ci: { title: '🤖 CI' },
    // Dockerfile и базовый образ касаются оператора напрямую (смена
    // node-образа меняет то, что крутится у него в проде), поэтому строкой,
    // а не в свёртку зависимостей.
    build: { title: '🧱 Build' },
    types: false,
    examples: false,
    test: false,
    style: false,
  },
  // Список авторов changelogen печатает с почтой из коммита, а это публичный
  // текст релиза. Кто прислал PR, видно по ссылке на коммит.
  noAuthors: true,
};
