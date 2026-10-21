#!/bin/sh
# Builds the scanner's test fixtures into $1 (the image's `fixtures` stage runs it; nothing here is
# committed as a binary). Markers: test/holdfast-test.ndb (test image only).
set -eu
out="$1"; ndb="$2"
mkdir -p "$out"; cd "$out"
hex2bin() { printf '%s' "$1" | sed 's/../\\x&/g' | xargs -0 printf '%b'; }
marker_hex="$(sed -n 's/^Holdfast\.Test\.Marker:0:\*://p' "$ndb")"
pua_hex="$(sed -n 's/^PUA\.Holdfast\.TestSample:0:\*://p' "$ndb")"
# The antivirus test string, in two halves so that this script is not itself reported.
printf '%s%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR' '-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > eicar.com
printf 'An ordinary text file.\n' > clean.txt
zip -q -X eicar.zip eicar.com
zip -q -X eicar-zip-in-zip.zip eicar.zip
# 20 levels of zip in zip (MaxRecursion is 16).
printf 'innermost\n' > level.txt; cp level.txt cur; name=level.txt
i=1
while [ "$i" -le 20 ]; do
  zip -q -X "l$i.zip" "$name"; name="l$i.zip"; i=$((i + 1))
done
cp l20.zip bomb-20.zip; rm -f l*.zip level.txt cur
# Encrypted archive of a harmless file. The password is made up and only locks this fixture.
zip -q -X -P not-a-real-password password.zip clean.txt
# A file the private PUA signature matches, alone and next to EICAR in both member orders.
{ head -c 4096 /dev/urandom; hex2bin "$pua_hex"; head -c 4096 /dev/urandom; } > pua.bin
zip -q -X pua-only.zip pua.bin
zip -q -X pua-then-eicar.zip pua.bin eicar.com
zip -q -X eicar-then-pua.zip eicar.com pua.bin
# Control: an ordinary (non-PUA) signature next to EICAR. clamd stops at the first match, so the
# member order decides the name; a PUA name first must NOT win the same way.
{ head -c 4096 /dev/urandom; hex2bin "$marker_hex"; head -c 4096 /dev/urandom; } > marker.bin
zip -q -X marker-then-eicar.zip marker.bin eicar.com
zip -q -X eicar-then-marker.zip eicar.com marker.bin
# A PUA match next to an alert that does not stop the scan (encrypted, limits): clamd reports one
# name, the last alert — the PUA name must never turn these into clean (review B1). Both member orders.
zip -q -X -P not-a-real-password enceicar.zip eicar.com
mkdir nest; cp eicar.com nest/n0; name=n0; i=1
while [ "$i" -le 17 ]; do
  (cd nest && zip -q -X "n$i.zip" "$name"); name="n$i.zip"; i=$((i + 1))
done
cp nest/n17.zip nest17-eicar.zip; rm -rf nest
for other in password enceicar bomb-20 nest17-eicar; do
  zip -q -X "$other-then-pua.zip" "$other.zip" pua.bin
  zip -q -X "pua-then-$other.zip" pua.bin "$other.zip"
done
# 10 MB with the private marker in its last 31 bytes, and the same without it.
head -c 9999969 /dev/urandom > head.bin
{ cat head.bin; hex2bin "$marker_hex"; } > marker-end.bin
{ cat head.bin; head -c 31 /dev/urandom; } > no-marker.bin
rm head.bin
ls -l
