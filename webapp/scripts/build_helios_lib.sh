#!/usr/bin/env bash
# Build the current Helios DAC SDK (USB + IDN, with WriteFrameHighResolution)
# into webapp/lib/libHeliosDacAPI.so (libHeliosDacAPI.dylib on macOS).
#
# Usage: bash webapp/scripts/build_helios_lib.sh
# Needs a C++14 compiler (g++ or clang++) and libusb-1.0. The system libusb is
# preferred (pkg-config libusb-1.0, then -lusb-1.0, then the runtime
# libusb-1.0.so.0); the copy bundled in sdk/cpp/libusb_bin is the last resort.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
webapp="$(cd "$here/.." && pwd)"
sdk="$(cd "$webapp/../sdk/cpp" && pwd)"
out_dir="$webapp/lib"
build_dir="$out_dir/build"
mkdir -p "$build_dir"

case "$(uname -s)" in
  Darwin) out="$out_dir/libHeliosDacAPI.dylib"; shared=(-dynamiclib); bundled="$sdk/libusb_bin/macOS/libusb-1.0.0.dylib" ;;
  *)      out="$out_dir/libHeliosDacAPI.so";    shared=(-shared);      bundled="$sdk/libusb_bin/Linux x64/libusb-1.0.so" ;;
esac

cxx="${CXX:-}"
if [ -z "$cxx" ]; then
  if command -v g++ >/dev/null 2>&1; then cxx=g++; elif command -v clang++ >/dev/null 2>&1; then cxx=clang++; else
    echo "error: no C++ compiler found (install g++ or clang++)" >&2; exit 1; fi
fi

# Pick how to link libusb.
can_link() {  # can_link <linker args...>
  echo 'int main(){return 0;}' > "$build_dir/probe.cpp"
  "$cxx" "$build_dir/probe.cpp" -o "$build_dir/probe" "$@" >/dev/null 2>&1
}
usb_link=()
if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists libusb-1.0; then
  read -r -a usb_link <<< "$(pkg-config --libs libusb-1.0)"
  echo "libusb: pkg-config (${usb_link[*]})"
elif can_link -lusb-1.0; then
  usb_link=(-lusb-1.0)
  echo "libusb: system -lusb-1.0"
else
  runtime=""
  for d in /lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu /lib/aarch64-linux-gnu /usr/lib/aarch64-linux-gnu \
           /lib/arm-linux-gnueabihf /usr/lib/arm-linux-gnueabihf /usr/lib64 /usr/lib /usr/local/lib /opt/homebrew/lib; do
    for f in "$d/libusb-1.0.so.0" "$d/libusb-1.0.0.dylib"; do
      if [ -z "$runtime" ] && [ -e "$f" ]; then runtime="$f"; fi
    done
  done
  if [ -n "$runtime" ] && can_link "$runtime"; then
    usb_link=("$runtime")
    echo "libusb: system runtime library $runtime (no -dev package installed)"
  elif [ -e "$bundled" ]; then
    usb_link=("$bundled")
    echo "libusb: bundled $bundled"
  else
    echo "error: libusb-1.0 not found (install libusb-1.0-0-dev)" >&2; exit 1
  fi
fi

# idn/idn.cpp uses va_start without including <cstdarg>; force-include it.
flags=(-Wall -std=c++14 -fPIC -O2 -I"$sdk" -include cstdarg)
sources=(
  "$sdk/shared_library/HeliosDacAPI.cpp"
  "$sdk/HeliosDac.cpp"
  "$sdk/idn/idn.cpp"
  "$sdk/idn/idnServerList.cpp"
  "$sdk/idn/plt-posix.cpp"
)
objects=()
for src in "${sources[@]}"; do
  obj="$build_dir/$(basename "${src%.cpp}").o"
  echo "compile $(basename "$src")"
  "$cxx" "${flags[@]}" -c "$src" -o "$obj" -w
  objects+=("$obj")
done

echo "link $out"
"$cxx" "${shared[@]}" -o "$out" "${objects[@]}" "${usb_link[@]}" -lpthread
rm -f "$build_dir/probe.cpp" "$build_dir/probe"
echo "built $out"
