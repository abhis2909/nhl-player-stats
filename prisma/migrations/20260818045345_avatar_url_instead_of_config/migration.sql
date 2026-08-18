/*
  Warnings:

  - You are about to drop the column `avatarConfig` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "User" DROP COLUMN "avatarConfig",
ADD COLUMN     "avatarUrl" TEXT;
