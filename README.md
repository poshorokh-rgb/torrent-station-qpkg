# Torrent Station — QPKG для QNAP (x86_64)

Торрент-клиент для QNAP как QPKG-пакет. Не собственный BT-движок, а
обёртка вокруг `transmission-daemon`, который ставится из **Entware**
(precompiled под архитектуру и libc вашего QTS). Поверх — свой веб-интерфейс
в духе qBittorrent (тёмная тема, RU/EN), который на старте подкладывается
в системную папку, откуда демон и так раздаёт статику
(`/opt/share/transmission/public_html`) — у этой сборки transmission-daemon
нет флага `--web-directory`, так что иначе не получится.

## Требования на NAS

- QNAP x86_64, QTS ≥ 4.3.3
- **Entware** уже установлен (App Center → поиск «Entware», либо
  https://github.com/Entware/Entware/wiki/Install-on-QNAP-NAS)

## Сборка (на этой машине)

```bash
./build.sh
```

Результат: `build/TorrentStation_1.0.0_x86_64.qpkg`

## Установка на NAS

```bash
scp build/TorrentStation_1.0.0_x86_64.qpkg admin@<NAS-IP>:/share/Public/
ssh admin@<NAS-IP> "sh /share/Public/TorrentStation_1.0.0_x86_64.qpkg"
```

Либо через App Center → шестерёнка → **Install Manually** → указать файл `.qpkg`.
Переустановка поверх — штатный сценарий: `installer.sh` копирует файлы заново
и делает `restart`.

При первом запуске скрипт сам поставит `transmission-daemon` и `transmission-web`
через opkg (нужен интернет на NAS) и сгенерирует случайный RPC-пароль.

## После установки

```bash
ssh admin@<NAS-IP> "cat /share/CACHEDEV1_DATA/.qpkg/TorrentStation/rpc-credentials.txt"
```

Web UI: `http://<NAS-IP>:9091/transmission/web/` — при заходе браузер спросит
логин/пароль своим системным окном (Basic Auth защищает весь путь `/transmission/`,
включая статику — у Transmission нет отдельного эндпоинта только для API, так что
свой красивый логин-экран сюда не встроить, только эта форма). После первого ввода
браузер помнит пароль на время сессии.

Управление сервисом:

```bash
/share/CACHEDEV1_DATA/.qpkg/TorrentStation/shared/TorrentStation.sh {start|stop|restart|status}
```

Логи: `.../TorrentStation/transmission.log`

## История загрузок

Отдельный журнал (добавлен/докачан) пишется самим `transmission-daemon`
через хуки `script-torrent-added`/`script-torrent-done` — работает даже
если браузер не открыт. Хранится **вне** `.qpkg/TorrentStation`, на самом
томе — `<VOL>/.torrentstation-history/history.jsonl` (например
`/share/CACHEDEV1_DATA/.torrentstation-history/history.jsonl`) — так он
переживает удаление папки пакета. Для веб-интерфейса та же история
зеркалируется в `/opt/share/transmission/public_html/history.jsonl`
(ресинк на каждый `start`/`restart`, на случай если `public_html` сбросился).
Смотреть в UI: иконка часов в шапке. Удаление торрента из списка в журнал
не попадает — у Transmission нет хука на этот случай.

## Известные грабли

- **Entware может сама поднять свой transmission-daemon при загрузке NAS**
  (init-скрипт вида `/opt/etc/init.d/S8Xtransmission`, если когда-то ставили
  transmission через голый opkg до этого пакета) — он конфликтует по порту
  9091 с нашим демоном, из-за чего страница у в браузере вечно крутится.
  Проверить: `ps w | grep transmission` — должен быть только один процесс,
  с путём `.../TorrentStation/...`. Если есть второй — `kill <pid>` и
  переименовать скрипт, чтобы не стартовал сам:
  `mv /opt/etc/init.d/S8Xtransmission /opt/etc/init.d/disabled.S8Xtransmission`
- **Правки `webui/*`**: браузеры агрессивно кэшируют статику без явных
  cache-заголовков. В `index.html` подключение файлов идёт с `?v=N` —
  **бампать номер при каждой правке CSS/JS**, иначе ни у вас, ни у
  пользователей изменения не подхватятся без ручной чистки кэша.
- `installer.sh`: определение тома (`/share/CACHEDEV1_DATA` vs
  `/share/CE_CACHEDEV1_DATA` и т.п.) и точный формат блока в
  `/etc/config/qpkg.conf` — версии QTS 4.x/5.x немного расходятся.
  Сверить с блоком уже установленного пакета (например Entware) в
  `/etc/config/qpkg.conf` на вашем NAS и подправить при необходимости.
- Порты (`rpc-port 9091`, `peer-port 51413`) и `download-dir` в
  `config/settings.json.template` — поменять под свою раскладку шар.

Дальше отлаживаем по факту установки на вашем NAS.
