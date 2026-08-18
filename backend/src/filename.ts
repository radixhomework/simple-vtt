/**
 * Uploaded filename decoding.
 *
 * Multer (via busboy) decodes multipart filenames as latin1, so a file named
 * "été.mp3" sent by a UTF-8 browser arrives as "Ã©tÃ©.mp3". Re-encoding the
 * string as latin1 recovers the original bytes, which then decode cleanly as
 * UTF-8. A name that was proper UTF-8 already contains characters above
 * U+00FF that cannot survive the latin1 round trip and produce U+FFFD, so we
 * leave those untouched — the repair is safe and idempotent in both cases.
 */
export function decodeUploadFilename(name: string): string {
  const repaired = Buffer.from(name, 'latin1').toString('utf8')
  return repaired.includes('\uFFFD') ? name : repaired
}
