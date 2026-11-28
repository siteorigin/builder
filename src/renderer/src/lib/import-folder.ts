/** The folder a file comes from, as its last two segments ("Trips/Shoreline"): what tells same-named, same-sized photos apart. */
export const fromFolder = (path: string) => path.split(/[\\/]/).filter(Boolean).slice(0, -1).slice(-2).join('/');
