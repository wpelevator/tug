/** Untyped JSON body of a fetch response; tests assert on the shape themselves. */
export const json = (res: Response): Promise<any> => res.json();
