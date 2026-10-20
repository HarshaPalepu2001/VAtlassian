export function findLinkType(linkTypes, name) {
  const wanted = String(name).trim().toLowerCase();
  return linkTypes.find((linkType) => String(linkType.name).trim().toLowerCase() === wanted) ?? null;
}
