# Third-party notices

Torrent Station packages Transmission 4.0.6 for Linux x86_64 together with
the runtime libraries it needs. It is included as a self-contained runtime so
users do not need to install Entware.

## Source and licenses

- Transmission 4.0.6 — GPL-2.0-or-later.
  Source: https://github.com/transmission/transmission/tree/4.0.6
- GNU C Library 2.27, GCC runtime libraries — LGPL-2.1-or-later with the
  GCC Runtime Library Exception where applicable.
  Source: https://ftp.gnu.org/gnu/glibc/ and https://gcc.gnu.org/
- OpenSSL 3.5.5 — Apache-2.0.
  Source: https://github.com/openssl/openssl/tree/openssl-3.5.5
- libcurl 8.15.0 — curl license.
  Source: https://github.com/curl/curl/tree/curl-8_15_0
- libevent 2.1.12, libdeflate 1.25, miniupnpc 2.2.8, libnatpmp 20230423,
  nghttp2 1.66.0, libpsl 0.21.5, libidn2 2.3.7, libunistring 1.4.1,
  libiconv, gettext, zlib 1.3.1 and libutp — their respective upstream
  open-source licenses.

The runtime was built for Entware's `x64-3.2` target and is distributed in
this package solely as executable form. Corresponding source code and each
project's full licence are available from the source links above. For a
complete source offer and reproducible release build, publish the exact
runtime archive checksums alongside each GitHub release.
