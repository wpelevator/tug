/** Untyped JSON body of a fetch response; tests assert on the shape themselves. */
export const json = (res: Response): Promise<any> => res.json();

/** Unrelated control tests keep their display image fixtures without network access. Pinning is covered separately. */
export const testImageResolver = async (image: string): Promise<string> => image;
