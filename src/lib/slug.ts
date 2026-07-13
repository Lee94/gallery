import { customAlphabet } from "nanoid";

// 去除易混字符（0O1lI），10 位约 58 bit 随机性，不可枚举
const ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";

export const generateSlug = customAlphabet(ALPHABET, 10);
