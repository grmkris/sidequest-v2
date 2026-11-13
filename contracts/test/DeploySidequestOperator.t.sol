// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuthCaptureEscrow} from "commerce-payments/src/AuthCaptureEscrow.sol";
import {ERC3009PaymentCollector} from "commerce-payments/src/collectors/ERC3009PaymentCollector.sol";

import {DeploySidequestOperator} from "../script/DeploySidequestOperator.s.sol";
import {SidequestOperator} from "../src/SidequestOperator.sol";

contract DeploySidequestOperatorTest is Test {
    DeploySidequestOperator internal script;

    function setUp() public {
        script = new DeploySidequestOperator();
    }

    function test_refusesMainnetsWithoutTheOptIn() public {
        uint256[5] memory mainnets = [uint256(1), 8453, 10, 42_161, 143];
        for (uint256 i; i < mainnets.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(DeploySidequestOperator.ChainNotAllowed.selector, mainnets[i]));
            script.requireAllowed(mainnets[i], "");
        }
    }

    function test_allowsTestnets() public view {
        script.requireTestnet(5_042_002);
        script.requireTestnet(84_532);
        script.requireTestnet(31_337);
    }

    function test_optInIsTheExactPhraseForThatChain() public {
        script.requireAllowed(8453, "deploy SidequestOperator to mainnet chain 8453");
        string[5] memory wrong = [
            "deploy SidequestOperator to mainnet chain 1",
            "deploy SidequestOperator to mainnet chain 8453 ",
            "Deploy SidequestOperator to mainnet chain 8453",
            "true",
            "1"
        ];
        for (uint256 i; i < wrong.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(DeploySidequestOperator.ChainNotAllowed.selector, 8453));
            script.requireAllowed(8453, wrong[i]);
        }
    }

    function test_mainnetTreasuryMustBeAContract() public {
        AuthCaptureEscrow escrow = new AuthCaptureEscrow();
        ERC3009PaymentCollector collector = new ERC3009PaymentCollector(address(escrow), address(1));
        DeploySidequestOperator.Plan memory plan = DeploySidequestOperator.Plan({
            chainId: 8453,
            testnet: false,
            mainnetOptIn: true,
            escrow: address(escrow),
            collector: address(collector),
            feeBps: 500,
            feeReceiver: makeAddr("a key, not a Safe"),
            deployer: address(this),
            predicted: address(0)
        });
        vm.expectRevert(
            abi.encodeWithSelector(DeploySidequestOperator.TreasuryNotAContract.selector, makeAddr("a key, not a Safe"))
        );
        script.checkOnChain(plan);

        plan.feeReceiver = address(collector);
        script.checkOnChain(plan);

        plan.testnet = true;
        plan.feeReceiver = makeAddr("a test treasury key");
        script.checkOnChain(plan);
    }

    /// @dev One test, because environment variables are process-wide and tests run in parallel.
    function test_deploysFromEnvRefusingMainnetsAndDryRunning() public {
        vm.setEnv("SIDEQUEST_DEPLOY_DRY_RUN", "false");
        vm.setEnv("SIDEQUEST_ALLOW_MAINNET_DEPLOY", "");
        uint256[5] memory mainnets = [uint256(1), 8453, 10, 42_161, 143];
        for (uint256 i; i < mainnets.length; ++i) {
            vm.chainId(mainnets[i]);
            vm.expectRevert(abi.encodeWithSelector(DeploySidequestOperator.ChainNotAllowed.selector, mainnets[i]));
            script.run();
        }
        // A phrase for another chain opts in to nothing here.
        vm.chainId(8453);
        vm.setEnv("SIDEQUEST_ALLOW_MAINNET_DEPLOY", "deploy SidequestOperator to mainnet chain 1");
        vm.expectRevert(abi.encodeWithSelector(DeploySidequestOperator.ChainNotAllowed.selector, 8453));
        script.run();
        vm.setEnv("SIDEQUEST_ALLOW_MAINNET_DEPLOY", "");

        vm.chainId(31_337);
        vm.setEnv("SIDEQUEST_FEE_RECEIVER", vm.toString(makeAddr("treasury")));
        vm.setEnv("AUTH_CAPTURE_ESCROW", vm.toString(makeAddr("nothing here")));
        vm.expectRevert(abi.encodeWithSelector(DeploySidequestOperator.MissingCode.selector, makeAddr("nothing here")));
        script.run();

        AuthCaptureEscrow escrow = new AuthCaptureEscrow();
        ERC3009PaymentCollector collector = new ERC3009PaymentCollector(address(escrow), address(1));
        vm.setEnv("AUTH_CAPTURE_ESCROW", vm.toString(address(escrow)));
        vm.setEnv("ERC3009_PAYMENT_COLLECTOR", vm.toString(address(collector)));
        vm.setEnv("SIDEQUEST_FEE_BPS", "65536");
        vm.expectRevert(abi.encodeWithSelector(DeploySidequestOperator.FeeOutOfRange.selector, 65_536));
        script.run();
        vm.setEnv("SIDEQUEST_FEE_BPS", "500");

        // A dry run on a mainnet needs no opt-in and deploys nothing, even where a real run would refuse.
        vm.chainId(8453);
        vm.setEnv("SIDEQUEST_DEPLOY_DRY_RUN", "true");
        vm.setEnv("SIDEQUEST_FEE_RECEIVER", vm.toString(address(collector)));
        DeploySidequestOperator.Plan memory plan = script.planFromEnv();
        assertFalse(plan.testnet);
        assertFalse(plan.mainnetOptIn);
        assertEq(address(script.run()), address(0));
        assertEq(plan.predicted.code.length, 0);
        vm.setEnv("SIDEQUEST_DEPLOY_DRY_RUN", "false");
        vm.setEnv("SIDEQUEST_FEE_RECEIVER", vm.toString(makeAddr("treasury")));

        vm.chainId(31_337);
        SidequestOperator op = script.run();
        assertEq(address(op.ESCROW()), address(escrow));
        assertEq(op.COLLECTOR(), address(collector));
        assertEq(op.FEE_BPS(), 500);
        assertEq(op.FEE_RECEIVER(), makeAddr("treasury"));
    }
}
