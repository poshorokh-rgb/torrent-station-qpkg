# TransmissionQ — QPKG для QNAP (x86_64)

Торрент-клиент для QNAP как QPKG-пакет. Не собственный BT-движок, а
обёртка вокруг `transmission-daemon`, который ставится из **Entware**
(precompiled под архитектуру и libc вашего QTS — надёжнее, чем городить
статическую кросс-компиляцию с нуля). Пакет даёт: автоустановку
transmission через opkg при первом старте, генерацию settings.json с
случайным RPC-паролем, init-скрипт start/stop/restart/status, встроенный
Web UI.

## Требования на NAS

- QNAP x86_64, QTS ≥ 4.3.3
- **Entware** уже установлен (App Center → поиск «Entware», либо
  https://github.com/Entware/Entware/wiki/Install-on-QNAP-NAS)

## Сборка (на этой машине)

```bash
./build.sh
```

Результат: `build/TransmissionQ_1.0.0_x86_64.qpkg`

## Установка на NAS

Скопировать на NAS и поставить одним из способов:

```bash
scp build/TransmissionQ_1.0.0_x86_64.qpkg admin@<NAS-IP>:/share/Public/
ssh admin@<NAS-IP> "sh /share/Public/TransmissionQ_1.0.0_x86_64.qpkg"
```

Либо через App Center → шестерёнка → **Install Manually** → указать файл `.qpkg`.

При первом запуске скрипт сам поставит `transmission-daemon-openssl` через
opkg (нужен интернет на NAS) и сгенерирует пароль.

## После установки

```bash
ssh admin@<NAS-IP> "cat /share/CACHEDEV1_DATA/.qpkg/TransmissionQ/rpc-credentials.txt"
```

Web UI: `http://<NAS-IP>:9091/transmission/web/`

Управление сервисом:

```bash
/share/CACHEDEV1_DATA/.qpkg/TransmissionQ/shared/TransmissionQ.sh {start|stop|restart|status}
```

Логи: `.../TransmissionQ/transmission.log`

## Известные места, которые может понадобиться поправить под ваш QTS

- `installer.sh`: определение тома (`/share/CACHEDEV1_DATA` vs
  `/share/CE_CACHEDEV1_DATA` и т.п.) и точный формат блока в
  `/etc/config/qpkg.conf` — версии QTS 4.x/5.x немного расходятся.
  Сверить с блоком уже установленного пакета (например Entware) в
  `/etc/config/qpkg.conf` на вашем NAS и подправить при необходимости.
- `TransmissionQ.sh`: путь до web-файлов Entware-пакета transmission
  (`--web-directory`, если понадобится нестандартный путь).
- Порты (`rpc-port 9091`, `peer-port 51413`) и `download-dir` —
  поменять под свою раскладку шар.

Дальше отлаживаем по факту установки на вашем NAS.
